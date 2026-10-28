import type { Model } from "@oh-my-pi/pi-ai";
import type { ProviderFileClient, ProviderFileHandle, ProviderFileUploadRequest } from "./provider-file-types";
import type { FetchImpl } from "./uploader-runtime";

/** DeepSeek's Files API is rooted at the deployment origin, not at the `/v1` chat path. */
const DEEPSEEK_FILES_URL = "https://api.deepseek.com/files";
/** Keep uploaded screenshots for 30 days; the API accepts 1 hour through 30 days. */
const DEEPSEEK_FILE_TTL_SECONDS = 2_592_000;

interface DeepSeekFileResponse {
	readonly id: string;
	readonly bytes: number;
	readonly expires_at?: number;
}

function isOfficialDeepSeekModel(model: Model): boolean {
	if (model.provider !== "deepseek") return false;
	if (model.api !== "openai-completions" && model.api !== "openai-responses") return false;

	try {
		const baseUrl = new URL(model.baseUrl);
		return (
			baseUrl.protocol === "https:" &&
			baseUrl.hostname === "api.deepseek.com" &&
			baseUrl.port === "" &&
			baseUrl.username === "" &&
			baseUrl.password === "" &&
			baseUrl.search === "" &&
			baseUrl.hash === ""
		);
	} catch {
		return false;
	}
}

function parseDeepSeekFileResponse(payload: unknown): DeepSeekFileResponse {
	if (typeof payload !== "object" || payload === null) {
		throw new Error("DeepSeek Files API returned an invalid upload response");
	}
	const file = payload as Record<string, unknown>;
	const { id, bytes, expires_at } = file;
	if (typeof id !== "string" || id.trim().length === 0) {
		throw new Error("DeepSeek Files API upload response is missing a file id");
	}
	if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
		throw new Error("DeepSeek Files API upload response has an invalid byte count");
	}
	if (expires_at !== undefined && (typeof expires_at !== "number" || !Number.isFinite(expires_at))) {
		throw new Error("DeepSeek Files API upload response has an invalid expiry");
	}
	return { id, bytes, expires_at };
}

/**
 * Create a DeepSeek Files API client for the official endpoint.
 *
 * Uploaded images are referenced through the OpenAI-compatible `file` content
 * block (`{"type":"file","file_id":"..."}`), or `input_image.file_id` on the
 * Responses API. A custom base URL returns `null`; the request stays inline.
 */
export function createDeepSeekFileClient(
	model: Model,
	credential: string,
	fetchImpl: FetchImpl = globalThis.fetch,
): ProviderFileClient | null {
	if (!isOfficialDeepSeekModel(model)) return null;
	if (credential.trim().length === 0) throw new Error("A DeepSeek API credential is required for file uploads");

	const authorization = `Bearer ${credential}`;
	const headers = { Authorization: authorization };
	return {
		provider: "deepseek",
		async upload(request: ProviderFileUploadRequest): Promise<ProviderFileHandle> {
			const preferred = request.filename?.trim().replaceAll("\\", "/").split("/").pop();
			const name = preferred && preferred !== "." && preferred !== ".." ? preferred : "image";
			const form = new FormData();
			form.append("purpose", "user_data");
			form.append("expires_after[anchor]", "created_at");
			form.append("expires_after[seconds]", String(DEEPSEEK_FILE_TTL_SECONDS));
			form.append("file", new Blob([request.bytes], { type: request.mimeType }), name);

			let response: Response;
			try {
				response = await fetchImpl(DEEPSEEK_FILES_URL, {
					method: "POST",
					headers,
					body: form,
					signal: request.signal,
				});
			} catch {
				throw new Error("DeepSeek Files API upload request failed");
			}
			if (!response.ok) {
				throw new Error(`DeepSeek Files API upload failed with HTTP ${response.status}`);
			}

			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new Error("DeepSeek Files API returned an invalid upload response");
			}
			const file = parseDeepSeekFileResponse(payload);
			return {
				provider: "deepseek",
				id: file.id,
				mimeType: request.mimeType,
				bytes: file.bytes,
				...(file.expires_at === undefined ? {} : { expiresAt: file.expires_at * 1_000 }),
				delete: {
					method: "DELETE",
					url: `${DEEPSEEK_FILES_URL}/${encodeURIComponent(file.id)}`,
					headers,
				},
			};
		},
		async delete(handle: ProviderFileHandle): Promise<void> {
			if (handle.provider !== "deepseek" || !handle.id) {
				throw new Error("Cannot delete an invalid DeepSeek file handle");
			}
			let response: Response;
			try {
				response = await fetchImpl(`${DEEPSEEK_FILES_URL}/${encodeURIComponent(handle.id)}`, {
					method: "DELETE",
					headers,
				});
			} catch {
				throw new Error("DeepSeek Files API delete request failed");
			}
			if (!response.ok) {
				throw new Error(`DeepSeek Files API delete failed with HTTP ${response.status}`);
			}
		},
	};
}
