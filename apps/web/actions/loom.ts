"use server";

import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	importedVideos,
	s3Buckets,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { dub, userIsPro } from "@cap/utils";
import { S3Buckets } from "@cap/web-backend";
import type { Organisation } from "@cap/web-domain";
import { S3Bucket, Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { start } from "workflow/api";
import {
	getMediaServerUrl,
	getWebhookUrl,
	pollMediaServerJob,
	startMediaServerJob,
} from "@/lib/media-server-jobs";
import { runPromise } from "@/lib/server";
import { canUseWorkflowEngine } from "@/lib/workflow-config";
import { importLoomVideoWorkflow } from "@/workflows/import-loom-video";

interface LoomUrlResponse {
	url?: string;
}

interface LoomDownloadResult {
	success: boolean;
	videoId?: string;
	videoName?: string;
	error?: string;
}

export interface LoomImportResult {
	success: boolean;
	videoId?: string;
	error?: string;
}

function extractLoomVideoId(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (!parsed.hostname.includes("loom.com")) {
			return null;
		}

		const pathParts = parsed.pathname.split("/").filter(Boolean);
		const id = pathParts[pathParts.length - 1] ?? null;

		if (!id || id.length < 10) {
			return null;
		}

		return id.split("?")[0] ?? null;
	} catch {
		return null;
	}
}

async function fetchLoomEndpoint(
	videoId: string,
	endpoint: string,
	includeBody = true,
): Promise<string | null> {
	try {
		const options: RequestInit = { method: "POST" };
		if (includeBody) {
			options.headers = {
				"Content-Type": "application/json",
				Accept: "application/json",
			};
			options.body = JSON.stringify({
				anonID: randomUUID(),
				deviceID: null,
				force_original: false,
				password: null,
			});
		}

		const response = await fetch(
			`https://www.loom.com/api/campaigns/sessions/${videoId}/${endpoint}`,
			options,
		);

		if (!response.ok || response.status === 204) {
			return null;
		}

		const text = await response.text();
		if (!text.trim()) {
			return null;
		}

		const data: LoomUrlResponse = JSON.parse(text);
		return data.url ?? null;
	} catch {
		return null;
	}
}

async function fetchVideoName(videoId: string): Promise<string | null> {
	try {
		const response = await fetch("https://www.loom.com/graphql", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"x-loom-request-source": "loom_web",
			},
			body: JSON.stringify({
				operationName: "GetVideoName",
				variables: { videoId, password: null },
				query: `query GetVideoName($videoId: ID!, $password: String) {
					getVideo(id: $videoId, password: $password) {
						... on RegularUserVideo { name }
						... on PrivateVideo { id }
						... on VideoPasswordMissingOrIncorrect { id }
					}
				}`,
			}),
		});

		if (!response.ok) return null;

		const data = await response.json();
		return data?.data?.getVideo?.name ?? null;
	} catch {
		return null;
	}
}

function isStreamingUrl(url: string): boolean {
	const path = (url.split("?")[0] ?? "").toLowerCase();
	return path.endsWith(".m3u8") || path.endsWith(".mpd");
}

async function getLoomDownloadUrl(loomVideoId: string): Promise<string | null> {
	const requestVariants: Array<{ endpoint: string; includeBody: boolean }> = [
		{ endpoint: "transcoded-url", includeBody: true },
		{ endpoint: "raw-url", includeBody: true },
		{ endpoint: "transcoded-url", includeBody: false },
		{ endpoint: "raw-url", includeBody: false },
	];

	let fallbackStreamingUrl: string | null = null;

	for (const { endpoint, includeBody } of requestVariants) {
		const url = await fetchLoomEndpoint(loomVideoId, endpoint, includeBody);
		if (!url) continue;

		if (!isStreamingUrl(url)) return url;

		if (!fallbackStreamingUrl) fallbackStreamingUrl = url;
	}

	return fallbackStreamingUrl;
}

async function fetchLoomOEmbed(
	loomVideoId: string,
): Promise<{ duration?: number; width?: number; height?: number } | null> {
	try {
		const response = await fetch(
			`https://www.loom.com/v1/oembed?url=https://www.loom.com/share/${loomVideoId}`,
			{ headers: { Accept: "application/json" } },
		);
		if (!response.ok) return null;
		const data = await response.json();
		return {
			duration: data.duration ? Math.round(data.duration) : undefined,
			width: data.width ?? undefined,
			height: data.height ?? undefined,
		};
	} catch {
		return null;
	}
}

export async function downloadLoomVideo(
	url: string,
): Promise<LoomDownloadResult> {
	if (!url || typeof url !== "string") {
		return { success: false, error: "Please provide a valid URL." };
	}

	const videoId = extractLoomVideoId(url.trim());

	if (!videoId) {
		return {
			success: false,
			error:
				"Invalid Loom URL. Please paste a valid Loom video link (e.g. https://www.loom.com/share/abc123).",
		};
	}

	try {
		const downloadUrl = await getLoomDownloadUrl(videoId);

		if (!downloadUrl) {
			return {
				success: false,
				error:
					"Could not retrieve a download URL. The video may be private, password-protected, or the link may have expired.",
			};
		}

		const videoName = await fetchVideoName(videoId);
		return {
			success: true,
			videoId,
			videoName: videoName ?? undefined,
		};
	} catch {
		return {
			success: false,
			error:
				"An unexpected error occurred. Please try again or check your internet connection.",
		};
	}
}

export async function importFromLoom({
	loomUrl,
	orgId,
}: {
	loomUrl: string;
	orgId: Organisation.OrganisationId;
}): Promise<LoomImportResult> {
	const user = await getCurrentUser();
	if (!user) return { success: false, error: "Unauthorized" };

	if (buildEnv.NEXT_PUBLIC_IS_CAP && !userIsPro(user)) {
		return {
			success: false,
			error: "Importing from Loom requires a Cap Pro subscription.",
		};
	}

	const loomVideoId = extractLoomVideoId(loomUrl.trim());
	if (!loomVideoId) {
		return {
			success: false,
			error:
				"Invalid Loom URL. Please paste a valid Loom video link (e.g. https://www.loom.com/share/abc123).",
		};
	}

	const existing = await db()
		.select({
			videoId: videos.id,
		})
		.from(importedVideos)
		.leftJoin(
			videos,
			and(
				eq(videos.id, importedVideos.id),
				eq(videos.orgId, importedVideos.orgId),
			),
		)
		.where(
			and(
				eq(importedVideos.orgId, orgId),
				eq(importedVideos.source, "loom"),
				eq(importedVideos.sourceId, loomVideoId),
			),
		);

	if (existing.some((row) => row.videoId !== null)) {
		return {
			success: false,
			error: "This Loom video has already been imported.",
		};
	}

	if (existing.length > 0) {
		await db()
			.delete(importedVideos)
			.where(
				and(
					eq(importedVideos.orgId, orgId),
					eq(importedVideos.source, "loom"),
					eq(importedVideos.sourceId, loomVideoId),
				),
			);
	}

	const downloadUrl = await getLoomDownloadUrl(loomVideoId);
	if (!downloadUrl) {
		return {
			success: false,
			error:
				"Could not retrieve a download URL. The video may be private, password-protected, or the link may have expired.",
		};
	}

	const [videoName, oembedMeta] = await Promise.all([
		fetchVideoName(loomVideoId),
		fetchLoomOEmbed(loomVideoId),
	]);

	const [customBucket] = await db()
		.select()
		.from(s3Buckets)
		.where(eq(s3Buckets.ownerId, user.id));

	const videoId = Video.VideoId.make(nanoId());
	const name =
		videoName ||
		`Loom Import - ${new Date().toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })}`;

	await db()
		.insert(videos)
		.values({
			id: videoId,
			name,
			ownerId: user.id,
			orgId,
			source: { type: "webMP4" as const },
			bucket: customBucket?.id,
			public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
			...(oembedMeta?.duration ? { duration: oembedMeta.duration } : {}),
			...(oembedMeta?.width ? { width: oembedMeta.width } : {}),
			...(oembedMeta?.height ? { height: oembedMeta.height } : {}),
		});

	await db().insert(videoUploads).values({
		videoId,
		phase: "uploading",
		processingProgress: 0,
		processingMessage: "Importing from Loom...",
	});

	await db().insert(importedVideos).values({
		id: videoId,
		orgId,
		source: "loom",
		sourceId: loomVideoId,
	});

	const rawFileKey = `${user.id}/${videoId}/raw-upload.mp4`;

	if (buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production") {
		await dub()
			.links.create({
				url: `${serverEnv().WEB_URL}/s/${videoId}`,
				domain: "cap.link",
				key: videoId,
			})
			.catch(() => {});
	}

	const importPayload = {
		videoId,
		userId: user.id,
		rawFileKey,
		bucketId: customBucket?.id ?? null,
		loomDownloadUrl: downloadUrl,
		loomVideoId,
	};

	if (canUseWorkflowEngine()) {
		await start(importLoomVideoWorkflow, [importPayload]);
	} else {
		executeDirectLoomImport(importPayload).catch(async (err) => {
			console.error("Direct Loom import failed:", err);
			await db()
				.update(videoUploads)
				.set({
					phase: "error",
					processingMessage:
						err instanceof Error ? err.message : "Import failed",
					updatedAt: new Date(),
				})
				.where(eq(videoUploads.videoId, videoId));
		});
	}

	revalidatePath("/dashboard/caps");

	return { success: true, videoId };
}

const MINIMUM_VIDEO_SIZE = 1024;

async function executeDirectLoomImport(payload: {
	videoId: string;
	userId: string;
	rawFileKey: string;
	bucketId: string | null;
	loomDownloadUrl: string;
	loomVideoId: string;
}): Promise<void> {
	const { videoId, userId, rawFileKey, bucketId, loomVideoId } = payload;

	await db()
		.update(videoUploads)
		.set({
			phase: "uploading",
			processingProgress: 0,
			processingMessage: "Downloading from Loom...",
			rawFileKey,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));

	const freshDownloadUrl = await getLoomDownloadUrl(loomVideoId);
	if (!freshDownloadUrl) {
		throw new Error(
			"Could not retrieve a download URL from Loom. The video may be private or expired.",
		);
	}

	const bucketIdOption = Option.fromNullable(bucketId).pipe(
		Option.map((id) => S3Bucket.S3BucketId.make(id)),
	);

	if (isStreamingUrl(freshDownloadUrl)) {
		await db()
			.update(videoUploads)
			.set({
				phase: "processing",
				processingProgress: 0,
				processingMessage: "Starting video processing...",
				updatedAt: new Date(),
			})
			.where(eq(videoUploads.videoId, videoId as Video.VideoId));

		await triggerMediaServerProcessing({
			videoId,
			userId,
			rawFileKey,
			bucketIdOption,
			sourceVideoUrl: freshDownloadUrl,
			inputExtension: getInputExtension(freshDownloadUrl),
		});
		return;
	}

	const presignedPutUrl = await Effect.gen(function* () {
		const [bucket] = yield* S3Buckets.getBucketAccess(bucketIdOption);
		return yield* bucket.getInternalPresignedPutUrl(rawFileKey, {
			ContentType: "video/mp4",
		});
	}).pipe(runPromise);

	const loomResponse = await fetch(freshDownloadUrl);
	if (!loomResponse.ok) {
		throw new Error(
			`Failed to download from Loom: ${loomResponse.status} ${loomResponse.statusText}`,
		);
	}

	const contentType = loomResponse.headers.get("content-type") ?? "";
	if (
		contentType.includes("text/html") ||
		contentType.includes("application/json")
	) {
		throw new Error(
			`Loom returned non-video content (${contentType}). The download URL may have expired.`,
		);
	}

	const videoBuffer = Buffer.from(await loomResponse.arrayBuffer());
	if (videoBuffer.length < MINIMUM_VIDEO_SIZE) {
		throw new Error(
			`Downloaded file is too small (${videoBuffer.length} bytes). The video may not be available.`,
		);
	}

	const uploadResponse = await fetch(presignedPutUrl, {
		method: "PUT",
		body: new Uint8Array(videoBuffer),
		headers: {
			"Content-Type": "video/mp4",
			"Content-Length": videoBuffer.length.toString(),
		},
	});

	if (!uploadResponse.ok) {
		throw new Error(
			`Failed to upload to S3: ${uploadResponse.status} ${uploadResponse.statusText}`,
		);
	}

	await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Starting video processing...",
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));

	await triggerMediaServerProcessing({
		videoId,
		userId,
		rawFileKey,
		bucketIdOption,
	});
}

function getInputExtension(url: string): string | undefined {
	const pathname = new URL(url).pathname.toLowerCase();
	if (pathname.endsWith(".m3u8")) return ".m3u8";
	if (pathname.endsWith(".mpd")) return ".mpd";
	if (pathname.endsWith(".mp4")) return ".mp4";
	return undefined;
}

async function triggerMediaServerProcessing(opts: {
	videoId: string;
	userId: string;
	rawFileKey: string;
	bucketIdOption: Option.Option<S3Bucket.S3BucketId>;
	sourceVideoUrl?: string;
	inputExtension?: string;
}): Promise<void> {
	const { videoId, userId, rawFileKey, bucketIdOption } = opts;
	const mediaServerUrl = getMediaServerUrl();
	const webhookUrl = getWebhookUrl();

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

	const videoUrl = opts.sourceVideoUrl ?? rawVideoUrl;

	const jobId = await startMediaServerJob(mediaServerUrl, {
		videoId,
		userId,
		videoUrl,
		outputPresignedUrl,
		thumbnailPresignedUrl,
		webhookUrl,
		inputExtension: opts.inputExtension,
	});

	const result = await pollMediaServerJob(mediaServerUrl, jobId);

	await db()
		.update(videos)
		.set({
			width: result.width,
			height: result.height,
			duration: result.duration,
		})
		.where(eq(videos.id, videoId as Video.VideoId));

	await db()
		.delete(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));
}
