import * as vscode from 'vscode';
import { EndpointConfig, resolveEndpoints } from './endpoints';

/**
 * Walks a user from "I have a local model running" to "it is selectable in the
 * chat picker" without their opening a JSON file.
 *
 * The step this exists to remove is the one the extension cannot do for you:
 * VS Code's chat model list lives in `chatLanguageModels.json`, there is no API
 * to write it, and the entry needs a model id that must match the server
 * exactly and a base URL that must be the *proxy* rather than the engine when
 * one is in play. Every part of that is guessable wrongly. So the command
 * derives all of it, puts the finished block on the clipboard, and opens the
 * file at the right place.
 */
export async function setUpModel(log: vscode.LogOutputChannel): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('inferenceHud');
	const { endpoints } = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Looking for local models…' },
		() =>
			resolveEndpoints(
				cfg.get<EndpointConfig[]>('endpoints', []),
				cfg.get<boolean>('autoDetect', true),
				cfg.get<boolean>('autoProxy', false),
				cfg.get<number>('autoProxyPort', 8788)
			)
	);

	if (endpoints.length === 0) {
		const pick = await vscode.window.showWarningMessage(
			'No local inference server found. Start one, then run this again.',
			'Open Log'
		);
		if (pick === 'Open Log') {
			log.show();
		}
		return;
	}

	const chosen =
		endpoints.length === 1
			? endpoints[0]
			: (
					await vscode.window.showQuickPick(
						endpoints.map(e => ({
							label: e.label,
							description: e.url,
							detail:
								e.adapter.id === 'proxy'
									? 'traffic routed through the extension so it can be measured'
									: `measured directly (${e.adapter.displayName})`,
							endpoint: e
						})),
						{ title: 'Which server?', placeHolder: 'Select an inference server' }
					)
				)?.endpoint;
	if (!chosen) {
		return;
	}

	// When a proxy carries this endpoint's traffic the client must be pointed at
	// the proxy, not the engine — sending to the engine works but is invisible,
	// which is the single most confusing way for this to fail.
	const clientBase = chosen.proxyPort
		? `http://127.0.0.1:${chosen.proxyPort}/v1`
		: `${chosen.url}/v1`;

	const models = await listModels(chosen.url);
	if (models.length === 0) {
		vscode.window.showWarningMessage(
			`${chosen.url} reported no models. Load one in the engine, then run this again.`
		);
		return;
	}

	const model =
		models.length === 1
			? models[0]
			: await vscode.window.showQuickPick(models, {
					title: 'Which model?',
					placeHolder: 'Select a model to add to the chat picker'
				});
	if (!model) {
		return;
	}

	const entry = {
		name: `Local ${shortHost(chosen.url)}`,
		vendor: 'customendpoint',
		apiType: 'chat-completions',
		models: [
			{
				id: model,
				name: `${model} (Inference HUD)`,
				url: clientBase,
				toolCalling: true,
				maxInputTokens: 28000,
				maxOutputTokens: 4096
			}
		]
	};
	const block = JSON.stringify(entry, null, 2);

	await vscode.env.clipboard.writeText(block);
	log.info(`setup: prepared chat model entry for ${model} at ${clientBase}`);

	const action = await vscode.window.showInformationMessage(
		`Copied a chat model entry for ${model}, pointing at ${clientBase}. ` +
			'Paste it into the array in chatLanguageModels.json.',
		'Open chatLanguageModels.json',
		'Done'
	);
	if (action === 'Open chatLanguageModels.json') {
		// The command that owns this file, rather than a path guess: the file
		// is profile-scoped, so its location moves with the active profile.
		await vscode.commands.executeCommand('workbench.action.openLanguageModelsJson');
	}
}

/**
 * Ask the server what it serves. The id has to match exactly on engines like
 * vLLM, so it is read rather than typed.
 */
async function listModels(baseUrl: string): Promise<string[]> {
	try {
		const res = await fetch(`${baseUrl}/v1/models`, { headers: { connection: 'close' } });
		if (!res.ok) {
			return [];
		}
		const body = (await res.json()) as { data?: { id?: string }[] };
		return (body.data ?? []).map(m => m.id).filter((id): id is string => !!id);
	} catch {
		return [];
	}
}

function shortHost(url: string): string {
	try {
		return new URL(url).port || new URL(url).hostname;
	} catch {
		return url;
	}
}
