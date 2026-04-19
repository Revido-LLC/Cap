import { db } from "@cap/database";
import { users, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";

/**
 * Convert Cap's WebVTT transcript into plain text.
 *
 * Cap's Deepgram pipeline emits cues in the shape:
 *
 *     WEBVTT
 *
 *     1
 *     00:00:00.000 --> 00:00:02.000
 *     Hello world.
 *
 *     2
 *     00:00:02.000 --> 00:00:04.000
 *     Next sentence.
 *
 * We strip the WEBVTT header, cue-index lines (bare integers), and timestamp
 * lines, leaving just the transcript text joined by newlines. Speaker
 * diarization is not enabled today, so there are no `<v Speaker>` tags to
 * handle — if Cap enables it later, add a cue-tag strip step.
 */
export function vttToPlainText(vtt: string): string {
	return vtt
		.replace(/^WEBVTT\s*/m, "")
		.replace(
			/^\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}.*$/gm,
			"",
		)
		.replace(/^\d+\s*$/gm, "")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.join("\n");
}

interface NotifyRevidoArgs {
	videoId: string;
	transcription: string;
}

/**
 * Forward a completed transcript to the Revido portal webhook.
 *
 * Fire-and-forget semantics: errors are logged but never thrown. Failures here
 * must not fail the transcription workflow — the user's recording is saved
 * regardless of whether Revido accepts it.
 *
 * Skipped when REVIDO_WEBHOOK_URL or REVIDO_WEBHOOK_SECRET are unset. A one-line
 * info log is emitted on skip so non-Revido deployments and misconfigured
 * Revido deploys are both visible in logs.
 *
 * Retries 5xx and network errors up to 3 times with backoff (1s / 5s). Does NOT
 * retry 4xx — those indicate a caller-side problem (auth, validation) that
 * won't resolve by retrying.
 */
export async function notifyRevido({
	videoId,
	transcription,
}: NotifyRevidoArgs): Promise<void> {
	"use step";

	try {
		const env = serverEnv();
		const url = env.REVIDO_WEBHOOK_URL;
		const secret = env.REVIDO_WEBHOOK_SECRET;

		if (!url || !secret) {
			console.log(
				`[notify-revido] Skipping ${videoId}: REVIDO_WEBHOOK_URL/SECRET not configured`,
			);
			return;
		}

		const [row] = await db()
			.select({
				id: videos.id,
				name: videos.name,
				duration: videos.duration,
				createdAt: videos.createdAt,
				email: users.email,
			})
			.from(videos)
			.leftJoin(users, eq(videos.ownerId, users.id))
			.where(eq(videos.id, videoId as Video.VideoId))
			.limit(1);

		if (!row || !row.email) {
			console.warn(
				`[notify-revido] Skipping ${videoId}: hasRow=${!!row} hasEmail=${!!row?.email}`,
			);
			return;
		}

		const transcriptText = vttToPlainText(transcription);

		const payload = {
			source: "cap" as const,
			videoId: row.id,
			recorderEmail: row.email,
			transcriptText,
			transcriptVtt: transcription,
			title: row.name || undefined,
			duration: row.duration ?? undefined,
			recordedAt: row.createdAt?.toISOString(),
		};

		await deliverWithRetry({
			url,
			secret,
			body: JSON.stringify(payload),
			videoId,
		});
	} catch (err) {
		console.error(
			`[notify-revido] Unexpected error for ${videoId}:`,
			err instanceof Error ? { name: err.name, message: err.message } : err,
		);
	}
}

interface DeliverArgs {
	url: string;
	secret: string;
	body: string;
	videoId: string;
}

const BACKOFF_MS = [1_000, 5_000];

async function deliverWithRetry({
	url,
	secret,
	body,
	videoId,
}: DeliverArgs): Promise<void> {
	const maxAttempts = BACKOFF_MS.length + 1;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${secret}`,
				},
				body,
				signal: AbortSignal.timeout(15_000),
			});

			if (response.ok) {
				console.log(`[notify-revido] Delivered transcript for ${videoId}`);
				return;
			}

			// 4xx is a caller-side problem (auth, validation). Don't retry.
			if (response.status >= 400 && response.status < 500) {
				const errBody = await response.text().catch(() => "");
				console.error(
					`[notify-revido] Webhook 4xx for ${videoId}: HTTP ${response.status} ${errBody.slice(0, 200)}`,
				);
				return;
			}

			// 5xx — retry with backoff
			if (attempt < maxAttempts) {
				const delay = BACKOFF_MS[attempt - 1] ?? 5_000;
				console.warn(
					`[notify-revido] Webhook 5xx for ${videoId}: HTTP ${response.status} attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms`,
				);
				await new Promise((r) => setTimeout(r, delay));
				continue;
			}
			const errBody = await response.text().catch(() => "");
			console.error(
				`[notify-revido] Webhook 5xx exhausted for ${videoId}: HTTP ${response.status} ${errBody.slice(0, 200)}`,
			);
			return;
		} catch (err) {
			const name = err instanceof Error ? err.name : "unknown";
			const isTimeout = name === "TimeoutError" || name === "AbortError";
			const label = isTimeout ? "timeout" : "network error";

			if (attempt < maxAttempts) {
				const delay = BACKOFF_MS[attempt - 1] ?? 5_000;
				console.warn(
					`[notify-revido] Webhook ${label} for ${videoId}: attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms`,
				);
				await new Promise((r) => setTimeout(r, delay));
				continue;
			}
			console.error(
				`[notify-revido] Webhook ${label} exhausted for ${videoId}:`,
				err instanceof Error ? { name: err.name, message: err.message } : err,
			);
			return;
		}
	}
}
