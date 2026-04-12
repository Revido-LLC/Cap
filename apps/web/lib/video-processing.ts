import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import type { S3Bucket, Video } from "@cap/web-domain";
import { and, eq, ne } from "drizzle-orm";
import { Effect, Option } from "effect";
import { start } from "workflow/api";
import {
	getMediaServerUrl,
	getWebhookUrl,
	pollMediaServerJob,
	startMediaServerJob,
} from "@/lib/media-server-jobs";
import { runPromise } from "@/lib/server";
import { canUseWorkflowEngine } from "@/lib/workflow-config";
import { processVideoWorkflow } from "@/workflows/process-video";

export type VideoProcessingStartStatus = "started" | "already-processing";

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}

	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

export async function setVideoProcessingError(
	videoId: Video.VideoId,
	processingMessage: string,
	error: unknown,
): Promise<void> {
	await db()
		.update(videoUploads)
		.set({
			phase: "error",
			processingProgress: 0,
			processingMessage,
			processingError: error instanceof Error ? error.message : String(error),
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId));
}

export async function transitionVideoToProcessing({
	videoId,
	rawFileKey,
	processingMessage,
	mode,
	forceRestart,
}: {
	videoId: Video.VideoId;
	rawFileKey: string;
	processingMessage: string;
	mode?: "singlepart" | "multipart";
	forceRestart?: boolean;
}): Promise<VideoProcessingStartStatus> {
	const result = await db()
		.update(videoUploads)
		.set({
			...(mode ? { mode } : {}),
			phase: "processing",
			processingProgress: 0,
			processingMessage,
			processingError: null,
			rawFileKey,
			updatedAt: new Date(),
		})
		.where(
			forceRestart
				? eq(videoUploads.videoId, videoId)
				: and(
						eq(videoUploads.videoId, videoId),
						ne(videoUploads.phase, "processing"),
					),
		);

	if (getAffectedRows(result) > 0) {
		return "started";
	}

	const [upload] = await db()
		.select()
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId));

	if (!upload) {
		throw new Error("No upload record found");
	}

	if (upload.phase === "processing") {
		return "already-processing";
	}

	throw new Error("Failed to transition upload to processing");
}

export async function startVideoProcessingWorkflow({
	videoId,
	userId,
	rawFileKey,
	bucketId,
	processingMessage,
	startFailureMessage,
	mode,
	forceRestart,
}: {
	videoId: Video.VideoId;
	userId: string;
	rawFileKey: string;
	bucketId: string | null;
	processingMessage: string;
	startFailureMessage: string;
	mode?: "singlepart" | "multipart";
	forceRestart?: boolean;
}): Promise<VideoProcessingStartStatus> {
	const status = await transitionVideoToProcessing({
		videoId,
		rawFileKey,
		processingMessage,
		mode,
		forceRestart,
	});

	if (status === "already-processing") {
		return status;
	}

	if (canUseWorkflowEngine()) {
		try {
			await start(processVideoWorkflow, [
				{
					videoId,
					userId,
					rawFileKey,
					bucketId: bucketId as S3Bucket.S3BucketId | null,
				},
			]);
			return "started";
		} catch (error) {
			const normalizedError =
				error instanceof Error
					? error
					: new Error("Video processing could not start");
			await setVideoProcessingError(
				videoId,
				startFailureMessage,
				normalizedError,
			);
			throw normalizedError;
		}
	}

	executeDirectVideoProcessing({
		videoId,
		userId,
		rawFileKey,
		bucketId,
	}).catch(async (err) => {
		console.error("[video-processing] Direct processing failed:", err);
		await setVideoProcessingError(
			videoId,
			startFailureMessage,
			err instanceof Error ? err : new Error(String(err)),
		);
	});

	return "started";
}

function getInputExtension(rawFileKey: string): string {
	const parts = rawFileKey.split(".");
	const extension = parts.at(-1)?.toLowerCase();
	if (!extension) return ".mp4";
	return `.${extension}`;
}

function getValidDuration(duration: number) {
	return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

async function executeDirectVideoProcessing(opts: {
	videoId: Video.VideoId;
	userId: string;
	rawFileKey: string;
	bucketId: string | null;
}): Promise<void> {
	const { videoId, userId, rawFileKey, bucketId } = opts;
	const mediaServerUrl = getMediaServerUrl();
	const webhookUrl = getWebhookUrl();
	const webhookSecret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;

	const bucketIdOption = Option.fromNullable(
		bucketId as S3Bucket.S3BucketId | null,
	);

	const { rawVideoUrl, outputPresignedUrl, thumbnailPresignedUrl } =
		await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(bucketIdOption);
			const outputKey = `${userId}/${videoId}/result.mp4`;
			const thumbnailKey = `${userId}/${videoId}/screenshot/screen-capture.jpg`;

			const rawVideoUrl = yield* bucket.getInternalSignedObjectUrl(rawFileKey);
			const outputPresignedUrl = yield* bucket.getInternalPresignedPutUrl(
				outputKey,
				{ ContentType: "video/mp4" },
			);
			const thumbnailPresignedUrl = yield* bucket.getInternalPresignedPutUrl(
				thumbnailKey,
				{ ContentType: "image/jpeg" },
			);

			return { rawVideoUrl, outputPresignedUrl, thumbnailPresignedUrl };
		}).pipe(runPromise);

	const jobId = await startMediaServerJob(mediaServerUrl, {
		videoId,
		userId,
		videoUrl: rawVideoUrl,
		outputPresignedUrl,
		thumbnailPresignedUrl,
		webhookUrl,
		webhookSecret: webhookSecret || undefined,
		inputExtension: getInputExtension(rawFileKey),
	});

	const metadata = await pollMediaServerJob(mediaServerUrl, jobId);
	const duration = getValidDuration(metadata.duration);

	await db()
		.update(videos)
		.set({
			width: metadata.width,
			height: metadata.height,
			fps: metadata.fps,
			...(duration === undefined ? {} : { duration }),
		})
		.where(eq(videos.id, videoId));

	await db().delete(videoUploads).where(eq(videoUploads.videoId, videoId));

	try {
		const [bucket] =
			await S3Buckets.getBucketAccess(bucketIdOption).pipe(runPromise);
		await bucket.deleteObject(rawFileKey).pipe(runPromise);
	} catch (error) {
		console.error("[video-processing] Failed to delete raw upload", error);
	}
}
