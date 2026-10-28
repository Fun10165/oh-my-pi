import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { convertMessages } from "../src/providers/openai-completions";
import type { Context, ImageContent, Model } from "../src/types";

const model = buildModel({
	...toModelSpec(getBundledModel("deepseek", "deepseek-flash")),
}) as Model<"openai-completions">;
const image: ImageContent = {
	type: "image",
	data: "aGVsbG8=",
	mimeType: "image/webp",
	providerFile: { provider: "deepseek", id: "file-api-test" },
};

function context(messages: Context["messages"]): Context {
	return { systemPrompt: [], tools: [], messages };
}

describe("DeepSeek file references on Chat Completions", () => {
	it("sends a user image as a flat file block instead of inline base64", () => {
		const converted = convertMessages(
			model,
			context([
				{
					role: "user",
					content: [{ type: "text", text: "look" }, image],
					timestamp: 1,
				},
			]),
			model.compat,
		);
		expect(converted[0]?.content).toEqual([
			{ type: "text", text: "look" },
			{ type: "file", file_id: "file-api-test" },
		]);
	});

	it("sends a tool-result image as a flat file block", () => {
		const converted = convertMessages(
			model,
			context([
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "browser", arguments: {} }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 0,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "browser",
					content: [{ type: "text", text: "screenshot" }, image],
					isError: false,
					timestamp: 1,
				},
			]),
			model.compat,
		);
		const last = converted[converted.length - 1];
		expect(last?.role).toBe("user");
		expect(last?.content).toEqual([
			{ type: "text", text: "Attached image(s) from tool result:" },
			{ type: "file", file_id: "file-api-test" },
		]);
	});

	it("keeps an inline image inline when no DeepSeek file reference is present", () => {
		const converted = convertMessages(
			model,
			context([
				{
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{ ...image, providerFile: undefined },
					],
					timestamp: 1,
				},
			]),
			model.compat,
		);
		expect(converted[0]?.content).toEqual([
			{ type: "text", text: "look" },
			{
				type: "image_url",
				image_url: { url: "data:image/webp;base64,aGVsbG8=" },
			},
		]);
	});
});
