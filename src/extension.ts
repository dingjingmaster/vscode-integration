// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	console.log('Extension "vscode-integration" is active.');

	const disposable = vscode.commands.registerCommand('s.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from s!');
	});

	const providerDisposable = vscode.languages.registerInlineCompletionItemProvider(
		{ pattern: '**' },
		new LlamaInlineCompletionProvider()
	);

	context.subscriptions.push(disposable, providerDisposable);
}

export function deactivate() {}

class LlamaInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	private readonly pendingCompletions = new Map<string, PendingCompletion>();

	public async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_inlineCompletionContext: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionList | undefined> {
		const config = vscode.workspace.getConfiguration('vscodeIntegration');
		const enabled = config.get<boolean>('enabled', true);
		if (!enabled) {
			return undefined;
		}
		const documentKey = document.uri.toString();
		const offset = document.offsetAt(position);

		const nextLine = this.tryGetNextLineFromPending(documentKey, document, offset);
		if (nextLine) {
			return new vscode.InlineCompletionList([
				new vscode.InlineCompletionItem(nextLine.insertText, new vscode.Range(position, position))
			]);
		}

		const maxPromptChars = config.get<number>('maxPromptChars', 4000);
		const maxTokens = config.get<number>('maxTokens', 128);
		const temperature = config.get<number>('temperature', 0.2);
		const baseUrl = config.get<string>('llamaServerBaseUrl', 'http://127.0.0.1:9999');
		const path = config.get<string>('llamaServerPath', '/completion');
		const model = config.get<string>('model', '');

		const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
		if (!prefix.trim()) {
			return undefined;
		}

		const prompt = prefix.slice(-Math.max(512, maxPromptChars));
		const body: Record<string, unknown> = {
			prompt,
			n_predict: maxTokens,
			max_tokens: maxTokens,
			temperature,
			stream: false
		};
		if (model.trim()) {
			body.model = model.trim();
		}

		try {
			const completionText = await requestCompletion(baseUrl, path, body, token);
			if (!completionText) {
				return undefined;
			}
			const normalized = normalizeNewlines(completionText);
			const aligned = alignCompletionIndentation(document, position, normalized);
			const sanitized = trimLineTrailingWhitespace(aligned);
			const chunks = splitIntoLineChunks(sanitized);
			if (chunks.length === 0) {
				return undefined;
			}

			const firstChunk = chunks[0];
			if (chunks.length > 1) {
				this.pendingCompletions.set(documentKey, {
					startOffset: offset,
					appliedText: firstChunk.appliedText,
					chunks,
					nextChunkIndex: 1
				});
			} else {
				this.pendingCompletions.delete(documentKey);
			}

			return new vscode.InlineCompletionList([
				new vscode.InlineCompletionItem(firstChunk.insertText, new vscode.Range(position, position))
			]);
		} catch (error) {
			if (error instanceof Error && !token.isCancellationRequested) {
				console.error(`[vscode-integration] llama completion failed: ${error.message}`);
			}
			return undefined;
		}
	}

	private tryGetNextLineFromPending(
		documentKey: string,
		document: vscode.TextDocument,
		offset: number
	): CompletionChunk | undefined {
		const pending = this.pendingCompletions.get(documentKey);
		if (!pending) {
			return undefined;
		}

		if (!isPendingCompletionValid(pending, document, offset)) {
			this.pendingCompletions.delete(documentKey);
			return undefined;
		}

		const chunk = pending.chunks[pending.nextChunkIndex];
		if (!chunk) {
			this.pendingCompletions.delete(documentKey);
			return undefined;
		}

		pending.appliedText += chunk.appliedText;
		pending.nextChunkIndex += 1;
		if (pending.nextChunkIndex >= pending.chunks.length) {
			this.pendingCompletions.delete(documentKey);
		}

		return chunk;
	}
}

interface PendingCompletion {
	startOffset: number;
	appliedText: string;
	chunks: CompletionChunk[];
	nextChunkIndex: number;
}

interface CompletionChunk {
	insertText: string | vscode.SnippetString;
	appliedText: string;
}

async function requestCompletion(
	baseUrl: string,
	path: string,
	body: Record<string, unknown>,
	token: vscode.CancellationToken
): Promise<string | undefined> {
	const endpoint = normalizeUrl(baseUrl, path);
	const response = await fetch(endpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body),
		signal: toAbortSignal(token)
	});

	if (!response.ok) {
		throw new Error(`HTTP ${response.status} from ${endpoint}`);
	}

	const data = (await response.json()) as Record<string, unknown>;
	return extractCompletionText(data);
}

function extractCompletionText(data: Record<string, unknown>): string | undefined {
	const content = asNonEmptyString(data.content);
	if (content) {
		return content;
	}

	const completion = asNonEmptyString(data.completion);
	if (completion) {
		return completion;
	}

	const text = asNonEmptyString(data.text);
	if (text) {
		return text;
	}

	const choices = data.choices;
	if (Array.isArray(choices) && choices.length > 0) {
		const first = choices[0] as Record<string, unknown>;
		const choiceText = asNonEmptyString(first.text);
		if (choiceText) {
			return choiceText;
		}
		const message = first.message as Record<string, unknown> | undefined;
		const messageContent = message ? asNonEmptyString(message.content) : undefined;
		if (messageContent) {
			return messageContent;
		}
	}

	return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function normalizeUrl(baseUrl: string, path: string): string {
	const normalizedBase = baseUrl.replace(/\/+$/, '');
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;
	return `${normalizedBase}${normalizedPath}`;
}

function toAbortSignal(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	}
	token.onCancellationRequested(() => controller.abort());
	return controller.signal;
}

function normalizeNewlines(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

function trimLineTrailingWhitespace(text: string): string {
	return text
		.split('\n')
		.map((line) => line.replace(/[ \t]+$/g, ''))
		.join('\n')
		.replace(/[ \t]+$/g, '');
}

function alignCompletionIndentation(
	document: vscode.TextDocument,
	position: vscode.Position,
	text: string
): string {
	const currentLinePrefix = document.lineAt(position.line).text.slice(0, position.character);
	const baseIndent = /^\s*$/.test(currentLinePrefix) ? currentLinePrefix : '';
	const lines = text.split('\n');
	if (lines.length === 0) {
		return text;
	}

	const firstLine = lines[0].replace(/^[ \t]+/, '');
	const remaining = lines.slice(1);
	const commonIndent = findCommonIndent(remaining);
	const reindented = remaining.map((line) => {
		if (line.length === 0) {
			return line;
		}
		const dedented = commonIndent.length > 0 && line.startsWith(commonIndent)
			? line.slice(commonIndent.length)
			: line;
		return `${baseIndent}${dedented}`;
	});

	return [firstLine, ...reindented].join('\n');
}

function findCommonIndent(lines: string[]): string {
	let common: string | undefined;
	for (const line of lines) {
		if (!line.trim()) {
			continue;
		}
		const indent = (line.match(/^[ \t]*/) ?? [''])[0];
		if (common === undefined) {
			common = indent;
			continue;
		}
		let index = 0;
		while (index < common.length && index < indent.length && common[index] === indent[index]) {
			index += 1;
		}
		common = common.slice(0, index);
		if (common.length === 0) {
			break;
		}
	}
	return common ?? '';
}

function splitIntoLineChunks(text: string): CompletionChunk[] {
	const lines = text.split('\n');
	const chunks: CompletionChunk[] = [];
	let preparedIndent = '';
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const startsWithPreparedIndent = preparedIndent.length > 0 && line.startsWith(preparedIndent);
		const effectiveLine = startsWithPreparedIndent ? line.slice(preparedIndent.length) : line;
		const isLast = index === lines.length - 1;
		if (isLast) {
			if (effectiveLine.length > 0) {
				chunks.push({
					insertText: effectiveLine,
					appliedText: effectiveLine
				});
			}
			continue;
		}

		const currentIndent = (line.match(/^[ \t]*/) ?? [''])[0];
		const appliedText = `${effectiveLine}\n${currentIndent}`;
		const snippetText = `${escapeSnippetText(effectiveLine)}\n${escapeSnippetText(currentIndent)}$0`;
		chunks.push({
			insertText: new vscode.SnippetString(snippetText),
			appliedText
		});
		preparedIndent = currentIndent;
	}
	return chunks;
}

function escapeSnippetText(text: string): string {
	return text.replace(/[$}\\]/g, '\\$&');
}

function isPendingCompletionValid(
	pending: PendingCompletion,
	document: vscode.TextDocument,
	offset: number
): boolean {
	const expectedOffset = pending.startOffset + pending.appliedText.length;
	if (offset !== expectedOffset) {
		return false;
	}
	const currentText = document.getText(
		new vscode.Range(document.positionAt(pending.startOffset), document.positionAt(offset))
	);
	return currentText === pending.appliedText;
}
