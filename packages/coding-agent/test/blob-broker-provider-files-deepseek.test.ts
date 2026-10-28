import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { createDeepSeekFileClient } from "../src/blob-broker/provider-files-deepseek";

const official = buildModel({ ...toModelSpec(getBundledModel("deepseek", "deepseek-flash")) });

describe("DeepSeek Files API client", () => {
	it("uploads with purpose=user_data, an expiry, and returns a reusable handle", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init: init ?? {} });
			return new Response(
				JSON.stringify({ id: "file-api-test", object: "file", bytes: 123, expires_at: 1_700_000_000 }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const client = createDeepSeekFileClient(official, "sk-test", fetchImpl);
		expect(client).not.toBeNull();
		const handle = await client!.upload({
			bytes: new Uint8Array([1, 2, 3]),
			mimeType: "image/webp",
			filename: "screenshot.webp",
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("https://api.deepseek.com/files");
		expect(calls[0]!.init.method).toBe("POST");
		expect(new Headers(calls[0]!.init.headers).get("Authorization")).toBe("Bearer sk-test");
		const form = calls[0]!.init.body as FormData;
		expect(form).toBeInstanceOf(FormData);
		expect(form.get("purpose")).toBe("user_data");
		expect(form.get("expires_after[anchor]")).toBe("created_at");
		expect(form.get("expires_after[seconds]")).toBe("2592000");
		const file = form.get("file") as File;
		expect(file.name).toBe("screenshot.webp");
		expect(file.type).toBe("image/webp");

		expect(handle).toMatchObject({
			provider: "deepseek",
			id: "file-api-test",
			mimeType: "image/webp",
			bytes: 123,
			expiresAt: 1_700_000_000_000,
		});
		expect(handle.delete).toMatchObject({
			method: "DELETE",
			url: "https://api.deepseek.com/files/file-api-test",
			headers: { Authorization: "Bearer sk-test" },
		});
	});

	it("deletes through the Files API id", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init: init ?? {} });
			return new Response(null, { status: 200 });
		};
		const client = createDeepSeekFileClient(official, "sk-test", fetchImpl)!;
		await client.delete({
			provider: "deepseek",
			id: "file-api-test",
			mimeType: "image/webp",
			bytes: 123,
			delete: { method: "DELETE", url: "https://api.deepseek.com/files/file-api-test" },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("https://api.deepseek.com/files/file-api-test");
		expect(calls[0]!.init.method).toBe("DELETE");
		expect(new Headers(calls[0]!.init.headers).get("Authorization")).toBe("Bearer sk-test");
	});

	it("stays disabled for a custom proxy base URL", () => {
		const custom = buildModel({
			...toModelSpec(getBundledModel("deepseek", "deepseek-flash")),
			baseUrl: "https://deepseek-proxy.example.com",
		});
		expect(createDeepSeekFileClient(custom, "sk-test", async () => new Response(null))).toBeNull();
	});
});
