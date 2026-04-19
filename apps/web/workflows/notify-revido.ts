import { db } from "@cap/database";
import { users, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";

/**
 * Convert Cap's WebVTT transcript into plain text with inline speaker labels.
 *
 * Deepgram WebVTT output uses `<v Speaker N>…</v>` cue tags. We strip the
 * WEBVTT header, timestamp lines, and cue tags, keeping speaker names inline
 * ("Speaker 1: Hello world") for readability by the Revido AI pipeline.
 */
export function vttToPlainText(vtt: string): string {
	return vtt
		.replace(/^WEBVTT\s*/m, "")
		.replace(
			/^\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}.*$/gm,
			"",
		)
		.replace(/<v ([^>]+)>/g, "$1: ")
		.replace(/<\/v>/g, "")
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
 * Skipped silently when REVIDO_WEBHOOK_URL or REVIDO_WEBHOOK_SECRET are unset
 * (useful for non-Revido Cap deployments and local development).
 */
export async function notifyRevido({
	videoId,
	transcription,
}: NotifyRevidoArgs): Promise<void> {
	"use step";

	const env = serverEnv();
	const url = env.REVIDO_WEBHOOK_URL;
	const secret = env.REVIDO_WEBHOOK_SECRET;

	if (!url || !secret) {
		return;
	}

	try {
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
			.where(eq(videos.id, videoId as Video.VideoId));

		if (!row || !row.email) {
			console.warn(
				`[notify-revido] Skipping ${videoId}: video or owner email not found`,
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

		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${secret}`,
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(15_000),
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			console.error(
				`[notify-revido] Webhook failed for ${videoId}: HTTP ${response.status} ${body.slice(0, 200)}`,
			);
			return;
		}

		console.log(`[notify-revido] Delivered transcript for ${videoId}`);
	} catch (err) {
		console.error(`[notify-revido] Unexpected error for ${videoId}:`, err);
	}
}
