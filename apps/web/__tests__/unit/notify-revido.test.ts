import { describe, expect, it } from "vitest";
import { vttToPlainText } from "@/workflows/notify-revido";

describe("vttToPlainText", () => {
	it("strips WEBVTT header, cue indices, and timestamp lines", () => {
		const vtt = [
			"WEBVTT",
			"",
			"1",
			"00:00:00.080 --> 00:00:00.320",
			"Hello world.",
			"",
			"2",
			"00:00:00.500 --> 00:00:02.000",
			"Next sentence here.",
			"",
		].join("\n");

		expect(vttToPlainText(vtt)).toBe("Hello world.\nNext sentence here.");
	});

	it("returns empty string for an empty VTT", () => {
		expect(vttToPlainText("WEBVTT\n\n")).toBe("");
	});

	it("handles multi-line cues with two text lines", () => {
		const vtt = [
			"WEBVTT",
			"",
			"1",
			"00:00:00.000 --> 00:00:02.000",
			"First line of cue.",
			"Second line of cue.",
			"",
		].join("\n");

		expect(vttToPlainText(vtt)).toBe("First line of cue.\nSecond line of cue.");
	});

	it("strips Deepgram cue-settings suffix on the timestamp line", () => {
		// Some VTT emitters add alignment/position settings after the timestamp.
		// Cap doesn't today, but this makes the parser resilient.
		const vtt = [
			"WEBVTT",
			"",
			"1",
			"00:00:00.000 --> 00:00:02.000 align:start position:50%",
			"With settings.",
			"",
		].join("\n");

		expect(vttToPlainText(vtt)).toBe("With settings.");
	});

	it("preserves text containing digits that aren't pure cue indices", () => {
		const vtt = [
			"WEBVTT",
			"",
			"1",
			"00:00:00.000 --> 00:00:02.000",
			"The year 2026 changed things.",
			"",
			"2",
			"00:00:02.000 --> 00:00:04.000",
			"50% of users agreed.",
			"",
		].join("\n");

		expect(vttToPlainText(vtt)).toBe(
			"The year 2026 changed things.\n50% of users agreed.",
		);
	});

	it("trims whitespace from surviving text lines", () => {
		const vtt = [
			"WEBVTT",
			"",
			"1",
			"00:00:00.000 --> 00:00:02.000",
			"   Padded sentence.   ",
			"",
		].join("\n");

		expect(vttToPlainText(vtt)).toBe("Padded sentence.");
	});
});
