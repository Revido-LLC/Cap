import { serverEnv } from "@cap/env";

const MEDIA_SERVER_START_MAX_ATTEMPTS = 6;
const MEDIA_SERVER_START_RETRY_BASE_MS = 2000;
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 360;

export interface MediaServerJobBody {
	videoId: string;
	userId: string;
	videoUrl: string;
	outputPresignedUrl: string;
	thumbnailPresignedUrl: string;
	webhookUrl: string;
	webhookSecret?: string;
	inputExtension?: string;
}

export interface MediaServerMetadata {
	duration: number;
	width: number;
	height: number;
	fps: number;
}

export function getMediaServerUrl(): string {
	const url = serverEnv().MEDIA_SERVER_URL;
	if (!url) {
		throw new Error("MEDIA_SERVER_URL is not configured");
	}
	return url;
}

export function getWebhookUrl(): string {
	const env = serverEnv();
	const webhookBaseUrl = env.MEDIA_SERVER_WEBHOOK_URL || env.WEB_URL;
	return `${webhookBaseUrl}/api/webhooks/media-server/progress`;
}

export async function startMediaServerJob(
	mediaServerUrl: string,
	body: MediaServerJobBody,
): Promise<string> {
	for (let attempt = 0; attempt < MEDIA_SERVER_START_MAX_ATTEMPTS; attempt++) {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (body.webhookSecret) {
			headers["x-media-server-secret"] = body.webhookSecret;
		}

		const response = await fetch(`${mediaServerUrl}/video/process`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (response.ok) {
			const { jobId } = (await response.json()) as { jobId: string };
			return jobId;
		}

		const errorData = (await response.json().catch(() => ({}))) as {
			error?: string;
			code?: string;
			details?: string;
			instanceId?: string;
			pid?: number;
			activeVideoProcesses?: number;
			maxConcurrentVideoProcesses?: number;
			jobCount?: number;
		};
		const baseErrorMessage =
			errorData.error ||
			errorData.details ||
			"Video processing failed to start";
		const busyDiagnostics =
			errorData.code === "SERVER_BUSY"
				? [
						errorData.instanceId ? `instance=${errorData.instanceId}` : null,
						typeof errorData.pid === "number" ? `pid=${errorData.pid}` : null,
						typeof errorData.activeVideoProcesses === "number" &&
						typeof errorData.maxConcurrentVideoProcesses === "number"
							? `active=${errorData.activeVideoProcesses}/${errorData.maxConcurrentVideoProcesses}`
							: null,
						typeof errorData.jobCount === "number"
							? `jobCount=${errorData.jobCount}`
							: null,
					]
						.filter(Boolean)
						.join(", ")
				: "";
		const errorMessage = busyDiagnostics
			? `${baseErrorMessage} (${busyDiagnostics})`
			: baseErrorMessage;
		const shouldRetry =
			response.status === 503 &&
			(errorData.code === "SERVER_BUSY" ||
				errorMessage.includes("Server is busy"));

		if (shouldRetry && attempt < MEDIA_SERVER_START_MAX_ATTEMPTS - 1) {
			await new Promise((resolve) =>
				setTimeout(resolve, MEDIA_SERVER_START_RETRY_BASE_MS * 2 ** attempt),
			);
			continue;
		}

		throw new Error(errorMessage);
	}

	throw new Error("Video processing failed to start");
}

export async function pollMediaServerJob(
	mediaServerUrl: string,
	jobId: string,
): Promise<MediaServerMetadata> {
	for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

		const response = await fetch(
			`${mediaServerUrl}/video/process/${jobId}/status`,
			{
				method: "GET",
				headers: { Accept: "application/json" },
			},
		);

		if (!response.ok) continue;

		const status = (await response.json()) as {
			phase: string;
			progress: number;
			error?: string;
			metadata?: MediaServerMetadata;
		};

		if (status.phase === "complete") {
			if (!status.metadata) {
				throw new Error("Processing completed but no metadata returned");
			}
			return status.metadata;
		}

		if (status.phase === "error") {
			throw new Error(status.error || "Video processing failed");
		}

		if (status.phase === "cancelled") {
			throw new Error("Video processing was cancelled");
		}
	}

	throw new Error("Video processing timed out");
}
