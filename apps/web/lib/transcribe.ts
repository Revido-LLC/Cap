import { promises as fs } from "node:fs";
import { db } from "@cap/database";
import {
	organizations,
	s3Buckets,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import type { S3Bucket, Video } from "@cap/web-domain";
import { createClient } from "@deepgram/sdk";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import { start } from "workflow/api";
import { checkHasAudioTrack, extractAudioFromUrl } from "@/lib/audio-extract";
import { startAiGeneration } from "@/lib/generate-ai";
import {
	checkHasAudioTrackViaMediaServer,
	extractAudioViaMediaServer,
	isMediaServerConfigured,
	probeVideoViaMediaServer,
} from "@/lib/media-client";
import { runPromise } from "@/lib/server";
import { type DeepgramResult, formatToWebVTT } from "@/lib/transcribe-utils";
import { canUseWorkflowEngine } from "@/lib/workflow-config";
import { transcribeVideoWorkflow } from "@/workflows/transcribe";

type TranscribeResult = {
	success: boolean;
	message: string;
};

export async function transcribeVideo(
	videoId: Video.VideoId,
	userId: string,
	aiGenerationEnabled = false,
	_isRetry = false,
): Promise<TranscribeResult> {
	if (!serverEnv().DEEPGRAM_API_KEY) {
		return {
			success: false,
			message: "Missing necessary environment variables",
		};
	}

	if (!userId || !videoId) {
		return {
			success: false,
			message: "userId or videoId not supplied",
		};
	}

	const query = await db()
		.select({
			video: videos,
			bucket: s3Buckets,
			settings: videos.settings,
			orgSettings: organizations.settings,
		})
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId));

	if (query.length === 0) {
		return { success: false, message: "Video does not exist" };
	}

	const result = query[0];
	if (!result || !result.video) {
		return { success: false, message: "Video information is missing" };
	}

	const { video } = result;

	if (!video) {
		return { success: false, message: "Video information is missing" };
	}

	if (
		video.settings?.disableTranscript ??
		result.orgSettings?.disableTranscript
	) {
		console.log(
			`[transcribeVideo] Transcription disabled for video ${videoId}`,
		);
		try {
			await db()
				.update(videos)
				.set({ transcriptionStatus: "SKIPPED" })
				.where(eq(videos.id, videoId));
		} catch (err) {
			console.error(`[transcribeVideo] Failed to mark as skipped:`, err);
			return {
				success: false,
				message: "Transcription disabled, but failed to update status",
			};
		}
		return {
			success: true,
			message: "Transcription disabled for video — skipping transcription",
		};
	}

	if (
		video.transcriptionStatus === "COMPLETE" ||
		video.transcriptionStatus === "PROCESSING" ||
		video.transcriptionStatus === "SKIPPED" ||
		video.transcriptionStatus === "NO_AUDIO"
	) {
		return {
			success: true,
			message: "Transcription already completed or in progress",
		};
	}

	const upload = await db()
		.select({ phase: videoUploads.phase })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId))
		.limit(1);

	if (
		upload[0]?.phase === "uploading" ||
		upload[0]?.phase === "processing" ||
		upload[0]?.phase === "generating_thumbnail"
	) {
		return {
			success: true,
			message: "Video upload is still in progress",
		};
	}

	try {
		console.log(
			`[transcribeVideo] Triggering transcription for video ${videoId}`,
		);

		if (canUseWorkflowEngine()) {
			await start(transcribeVideoWorkflow, [
				{
					videoId,
					userId,
					aiGenerationEnabled,
				},
			]);
		} else {
			executeDirectTranscription({
				videoId,
				userId,
				aiGenerationEnabled,
			}).catch((err) => {
				console.error("[transcribeVideo] Direct transcription failed:", err);
				db()
					.update(videos)
					.set({ transcriptionStatus: null })
					.where(eq(videos.id, videoId))
					.catch(() => {});
			});
		}

		return {
			success: true,
			message: "Transcription started",
		};
	} catch (error) {
		console.error("[transcribeVideo] Failed to trigger transcription:", error);

		await db()
			.update(videos)
			.set({ transcriptionStatus: null })
			.where(eq(videos.id, videoId));

		return {
			success: false,
			message: "Failed to start transcription",
		};
	}
}

async function resolveVideoSourceUrl(
	videoId: Video.VideoId,
	userId: string,
	bucketId: S3Bucket.S3BucketId | null,
): Promise<string> {
	const [bucket] = await S3Buckets.getBucketAccess(
		Option.fromNullable(bucketId),
	).pipe(runPromise);

	const upload = await db()
		.select({ rawFileKey: videoUploads.rawFileKey })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId))
		.limit(1);

	const candidateKeys = [
		`${userId}/${videoId}/result.mp4`,
		upload[0]?.rawFileKey,
	].filter(
		(value, index, values): value is string =>
			Boolean(value) && values.indexOf(value) === index,
	);

	for (const key of candidateKeys) {
		const url = await bucket.getInternalSignedObjectUrl(key).pipe(runPromise);
		const response = await fetch(url, {
			method: "GET",
			headers: { range: "bytes=0-0" },
		});

		if (response.ok) {
			console.log(`[transcribe] Using video source ${key}`);
			return url;
		}
	}

	throw new Error("Video file not accessible");
}

async function executeDirectTranscription(opts: {
	videoId: Video.VideoId;
	userId: string;
	aiGenerationEnabled: boolean;
}): Promise<void> {
	const { videoId, userId, aiGenerationEnabled } = opts;

	if (!serverEnv().DEEPGRAM_API_KEY) {
		throw new Error("Missing DEEPGRAM_API_KEY");
	}

	const query = await db()
		.select({
			video: videos,
			bucket: s3Buckets,
			settings: videos.settings,
			orgSettings: organizations.settings,
			owner: users,
		})
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.innerJoin(users, eq(videos.ownerId, users.id))
		.where(eq(videos.id, videoId));

	if (query.length === 0 || !query[0]?.video) {
		throw new Error("Video does not exist");
	}

	const result = query[0];
	const bucketId = (result.bucket?.id ?? null) as S3Bucket.S3BucketId | null;

	const transcriptionDisabled =
		result.video.settings?.disableTranscript ??
		result.orgSettings?.disableTranscript ??
		false;

	if (transcriptionDisabled) {
		await db()
			.update(videos)
			.set({ transcriptionStatus: "SKIPPED" })
			.where(eq(videos.id, videoId));
		return;
	}

	await db()
		.update(videos)
		.set({ transcriptionStatus: "PROCESSING" })
		.where(eq(videos.id, videoId));

	const [bucket] = await S3Buckets.getBucketAccess(
		Option.fromNullable(bucketId),
	).pipe(runPromise);

	const videoUrl = await resolveVideoSourceUrl(videoId, userId, bucketId);

	const useMediaServer = isMediaServerConfigured();
	let hasAudio: boolean;
	let audioBuffer: Buffer;

	if (useMediaServer) {
		try {
			const probe = await probeVideoViaMediaServer(videoUrl);
			hasAudio = probe.audioCodec !== null;
		} catch {
			hasAudio = await checkHasAudioTrackViaMediaServer(videoUrl);
		}

		if (!hasAudio) {
			await db()
				.update(videos)
				.set({ transcriptionStatus: "NO_AUDIO" })
				.where(eq(videos.id, videoId));
			return;
		}

		audioBuffer = await extractAudioViaMediaServer(videoUrl);
	} else {
		hasAudio = await checkHasAudioTrack(videoUrl);
		if (!hasAudio) {
			await db()
				.update(videos)
				.set({ transcriptionStatus: "NO_AUDIO" })
				.where(eq(videos.id, videoId));
			return;
		}

		const extractResult = await extractAudioFromUrl(videoUrl);
		try {
			audioBuffer = await fs.readFile(extractResult.filePath);
		} finally {
			await extractResult.cleanup();
		}
	}

	const audioKey = `${userId}/${videoId}/audio-temp.mp3`;

	await bucket
		.putObject(audioKey, audioBuffer, { contentType: "audio/mpeg" })
		.pipe(runPromise);

	const audioSignedUrl = await bucket
		.getInternalSignedObjectUrl(audioKey)
		.pipe(runPromise);

	const audioResponse = await fetch(audioSignedUrl);
	if (!audioResponse.ok) {
		throw new Error(`Audio URL not accessible: ${audioResponse.status}`);
	}

	const deepgramBuffer = Buffer.from(await audioResponse.arrayBuffer());
	const deepgram = createClient(serverEnv().DEEPGRAM_API_KEY as string);

	const { result: dgResult, error: dgError } =
		await deepgram.listen.prerecorded.transcribeFile(deepgramBuffer, {
			model: "nova-3",
			smart_format: true,
			detect_language: true,
			utterances: true,
			mime_type: "audio/mpeg",
		});

	if (dgError) {
		throw new Error(`Deepgram transcription failed: ${dgError.message}`);
	}

	const transcription = formatToWebVTT(dgResult as unknown as DeepgramResult);

	await bucket
		.putObject(`${userId}/${videoId}/transcription.vtt`, transcription, {
			contentType: "text/vtt",
		})
		.pipe(runPromise);

	await db()
		.update(videos)
		.set({ transcriptionStatus: "COMPLETE" })
		.where(eq(videos.id, videoId));

	try {
		await bucket.deleteObject(audioKey).pipe(runPromise);
	} catch (error) {
		console.error("[transcribe] Failed to cleanup temp audio:", error);
	}

	if (aiGenerationEnabled) {
		await startAiGeneration(videoId, userId);
	}
}
