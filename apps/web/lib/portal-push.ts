import { db } from "@cap/database";
import { folders, s3Buckets, users, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { S3Buckets } from "@cap/web-backend";
import type { S3Bucket, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { runPromise } from "@/lib/server";

const RETRY_DELAY_MS = 2_000;

interface PortalPayload {
	source: "cap";
	videoId: string;
	videoUrl: string;
	title: string;
	recorderEmail: string;
	recordedAt: string;
	duration: number | null;
	transcriptText: string;
	transcriptVtt: string;
	summary: string | null;
	folderName: string | null;
}

function flattenVtt(vttContent: string): string {
	return vttContent
		.split("\n")
		.filter(
			(line) =>
				line.trim() &&
				line.trim() !== "WEBVTT" &&
				!line.includes("-->") &&
				!/^\d+$/.test(line.trim()),
		)
		.join(" ")
		.trim();
}

export async function pushToPortal(
	videoId: Video.VideoId,
	userId: string,
): Promise<void> {
	const webhookUrl = process.env.REVIDO_PORTAL_WEBHOOK_URL;
	const webhookSecret = process.env.REVIDO_PORTAL_WEBHOOK_SECRET;
	if (!webhookUrl) return;

	const query = await db()
		.select({
			video: videos,
			bucket: s3Buckets,
			user: users,
			folder: folders,
		})
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.leftJoin(users, eq(videos.ownerId, users.id))
		.leftJoin(folders, eq(videos.folderId, folders.id))
		.where(eq(videos.id, videoId));

	if (query.length === 0 || !query[0]?.video || !query[0]?.user) {
		console.error("[portal-push] Video or user not found:", videoId);
		return;
	}

	const { video, bucket, user, folder } = query[0];
	const metadata = (video.metadata as VideoMetadata) || {};
	const bucketId = (bucket?.id ?? null) as S3Bucket.S3BucketId | null;

	const vtt = await Effect.gen(function* () {
		const [b] = yield* S3Buckets.getBucketAccess(Option.fromNullable(bucketId));
		return yield* b.getObject(`${userId}/${videoId}/transcription.vtt`);
	}).pipe(runPromise);

	if (Option.isNone(vtt)) {
		console.error("[portal-push] No VTT found for video:", videoId);
		return;
	}

	const rawVtt = vtt.value;
	const transcriptText = flattenVtt(rawVtt);
	if (transcriptText.length < 10) {
		console.error("[portal-push] Transcript too short, skipping:", videoId);
		return;
	}

	const webUrl = process.env.NEXT_PUBLIC_WEB_URL ?? "https://cap.so";

	const payload: PortalPayload = {
		source: "cap",
		videoId,
		videoUrl: `${webUrl}/s/${videoId}`,
		title: metadata.aiTitle || video.name || "Cap Recording",
		recorderEmail: user.email,
		recordedAt: video.createdAt.toISOString(),
		duration: video.duration ? Math.round(video.duration) : null,
		transcriptText,
		transcriptVtt: rawVtt,
		summary: metadata.summary ?? null,
		folderName: folder?.name ?? null,
	};

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (webhookSecret) {
		headers.Authorization = `Bearer ${webhookSecret}`;
	}

	const send = async (): Promise<Response> =>
		fetch(webhookUrl, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(15_000),
		});

	let res = await send();

	if (res.status >= 500 && res.status < 600) {
		await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
		res = await send();
	}

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		console.error(
			`[portal-push] Webhook failed for ${videoId}: ${res.status} ${body}`,
		);
		return;
	}

	console.log(`[portal-push] Pushed video ${videoId} to portal`);
}
