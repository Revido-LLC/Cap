import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — must be set up before importing the module under test
// ─────────────────────────────────────────────────────────────────────────────

let mockEnv: { REVIDO_WEBHOOK_URL?: string; REVIDO_WEBHOOK_SECRET?: string } = {
	REVIDO_WEBHOOK_URL: "https://revido.test/api/webhooks/cap",
	REVIDO_WEBHOOK_SECRET: "test-secret",
};

vi.mock("@cap/env", () => ({
	serverEnv: () => mockEnv,
}));

let mockVideoRow:
	| {
			id: string;
			name: string | null;
			duration: number | null;
			createdAt: Date | null;
			email: string | null;
	  }
	| null
	| undefined = undefined;

const limitFn = vi.fn(() =>
	Promise.resolve(mockVideoRow ? [mockVideoRow] : []),
);
const whereFn = vi.fn(() => ({ limit: limitFn }));
const leftJoinFn = vi.fn(() => ({ where: whereFn }));
const fromFn = vi.fn(() => ({ leftJoin: leftJoinFn }));
const selectFn = vi.fn(() => ({ from: fromFn }));

vi.mock("@cap/database", () => ({
	db: () => ({ select: selectFn }),
}));

vi.mock("@cap/database/schema", () => ({
	users: {},
	videos: {},
}));

vi.mock("drizzle-orm", () => ({
	eq: (_a: unknown, _b: unknown) => ({ _eq: true }),
}));

import { notifyRevido, vttToPlainText } from "@/workflows/notify-revido";

// ─────────────────────────────────────────────────────────────────────────────
// vttToPlainText — pure function, Tier 1
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// notifyRevido — service function with DB + HTTP, Tier 2
// ─────────────────────────────────────────────────────────────────────────────

describe("notifyRevido", () => {
	const validRow = {
		id: "vid_abc",
		name: "Meeting with Acme",
		duration: 180,
		createdAt: new Date("2026-04-19T10:00:00Z"),
		email: "user@revido.io",
	};

	const sampleVtt = [
		"WEBVTT",
		"",
		"1",
		"00:00:00.000 --> 00:00:02.000",
		"Hello.",
		"",
	].join("\n");

	const fetchMock = vi.fn();
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockEnv = {
			REVIDO_WEBHOOK_URL: "https://revido.test/api/webhooks/cap",
			REVIDO_WEBHOOK_SECRET: "test-secret",
		};
		mockVideoRow = validRow;
		globalThis.fetch = fetchMock as unknown as typeof fetch;
	});

	afterEach(() => {
		vi.useRealTimers();
		globalThis.fetch = originalFetch;
	});

	// ─── Skip / early-return paths ──────────────────────────────────────────

	it("skips when REVIDO_WEBHOOK_URL is not configured", async () => {
		mockEnv = { REVIDO_WEBHOOK_SECRET: "test-secret" };
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await notifyRevido({ videoId: "vid_abc", transcription: sampleVtt });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				"Skipping vid_abc: REVIDO_WEBHOOK_URL/SECRET not configured",
			),
		);
	});

	it("skips when REVIDO_WEBHOOK_SECRET is not configured", async () => {
		mockEnv = { REVIDO_WEBHOOK_URL: "https://revido.test/api/webhooks/cap" };
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await notifyRevido({ videoId: "vid_abc", transcription: sampleVtt });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("not configured"),
		);
	});

	it("skips when the video row is not found", async () => {
		mockVideoRow = null;
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		await notifyRevido({ videoId: "vid_missing", transcription: sampleVtt });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Skipping vid_missing: hasRow=false"),
		);
	});

	it("skips when the video owner has no email", async () => {
		mockVideoRow = { ...validRow, email: null };
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		await notifyRevido({ videoId: "vid_abc", transcription: sampleVtt });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("hasRow=true hasEmail=false"),
		);
	});

	// ─── Happy path + payload shape ────────────────────────────────────────

	it("delivers the payload with Bearer auth and expected fields", async () => {
		fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));

		await notifyRevido({ videoId: "vid_abc", transcription: sampleVtt });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://revido.test/api/webhooks/cap");
		expect(init.method).toBe("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-secret");
		expect(headers["Content-Type"]).toBe("application/json");

		const body = JSON.parse(init.body as string);
		expect(body).toMatchObject({
			source: "cap",
			videoId: "vid_abc",
			recorderEmail: "user@revido.io",
			title: "Meeting with Acme",
			duration: 180,
			recordedAt: "2026-04-19T10:00:00.000Z",
			transcriptVtt: sampleVtt,
		});
		expect(body.transcriptText).toBe("Hello.");
	});

	it("omits optional fields when source data is null/undefined", async () => {
		mockVideoRow = {
			id: "vid_bare",
			name: null,
			duration: null,
			createdAt: null,
			email: "user@revido.io",
		};
		fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));

		await notifyRevido({ videoId: "vid_bare", transcription: sampleVtt });

		const body = JSON.parse(
			(fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
		);
		expect(body.title).toBeUndefined();
		expect(body.duration).toBeUndefined();
		expect(body.recordedAt).toBeUndefined();
	});

	// ─── Retry behavior ────────────────────────────────────────────────────

	it("does NOT retry on 4xx (caller-side problem)", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response("bad request", { status: 400 }),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await notifyRevido({ videoId: "vid_abc", transcription: sampleVtt });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Webhook 4xx for vid_abc: HTTP 400"),
		);
	});

	it("retries on 5xx and succeeds on attempt 2", async () => {
		fetchMock
			.mockResolvedValueOnce(new Response("oops", { status: 500 }))
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const promise = notifyRevido({
			videoId: "vid_abc",
			transcription: sampleVtt,
		});
		// Advance past the 1s backoff
		await vi.advanceTimersByTimeAsync(1_000);
		await promise;

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Webhook 5xx for vid_abc: HTTP 500 attempt 1/3"),
		);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("Delivered transcript for vid_abc"),
		);
	});

	it("exhausts retries after 3 failed attempts on 5xx", async () => {
		fetchMock.mockResolvedValue(new Response("down", { status: 503 }));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const promise = notifyRevido({
			videoId: "vid_abc",
			transcription: sampleVtt,
		});
		// Advance past 1s + 5s backoffs
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.advanceTimersByTimeAsync(5_000);
		await promise;

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("5xx exhausted for vid_abc: HTTP 503"),
		);
	});

	it("retries on network error and eventually succeeds", async () => {
		fetchMock
			.mockRejectedValueOnce(new TypeError("network failed"))
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const promise = notifyRevido({
			videoId: "vid_abc",
			transcription: sampleVtt,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		await promise;

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("network error for vid_abc: attempt 1/3"),
		);
	});

	it("distinguishes timeout errors in logs", async () => {
		const timeoutErr = new Error("timed out");
		timeoutErr.name = "TimeoutError";
		fetchMock
			.mockRejectedValueOnce(timeoutErr)
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const promise = notifyRevido({
			videoId: "vid_abc",
			transcription: sampleVtt,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		await promise;

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("timeout for vid_abc: attempt 1/3"),
		);
	});

	// ─── Fire-and-forget contract ──────────────────────────────────────────

	it("never throws — any unexpected error is caught and logged", async () => {
		// Force the DB call to throw
		limitFn.mockRejectedValueOnce(new Error("db connection lost"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			notifyRevido({ videoId: "vid_abc", transcription: sampleVtt }),
		).resolves.toBeUndefined();

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Unexpected error for vid_abc"),
			expect.objectContaining({ name: "Error", message: "db connection lost" }),
		);
	});
});
