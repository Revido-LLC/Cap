import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import type { S3Bucket, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { start } from "workflow/api";
import { GROQ_MODEL, getGroqClient } from "@/lib/groq-client";
import { runPromise } from "@/lib/server";
import { canUseWorkflowEngine } from "@/lib/workflow-config";
import { generateAiWorkflow } from "@/workflows/generate-ai";

type GenerateAiResult = {
	success: boolean;
	message: string;
};

export async function startAiGeneration(
	videoId: Video.VideoId,
	userId: string,
): Promise<GenerateAiResult> {
	if (!serverEnv().GROQ_API_KEY && !serverEnv().OPENAI_API_KEY) {
		return {
			success: false,
			message: "Missing AI API keys (Groq or OpenAI)",
		};
	}

	if (!userId || !videoId) {
		return {
			success: false,
			message: "userId or videoId not supplied",
		};
	}

	const query = await db()
		.select({ video: videos })
		.from(videos)
		.where(eq(videos.id, videoId));

	if (query.length === 0 || !query[0]?.video) {
		return { success: false, message: "Video does not exist" };
	}

	const { video } = query[0];

	if (video.transcriptionStatus !== "COMPLETE") {
		return {
			success: false,
			message: "Transcription not complete",
		};
	}

	const metadata = (video.metadata as VideoMetadata) || {};

	if (
		metadata.aiGenerationStatus === "PROCESSING" ||
		metadata.aiGenerationStatus === "QUEUED"
	) {
		return {
			success: true,
			message: "AI generation already in progress",
		};
	}

	if (
		metadata.aiGenerationStatus === "COMPLETE" &&
		metadata.summary &&
		metadata.chapters
	) {
		return {
			success: true,
			message: "AI metadata already generated",
		};
	}

	try {
		await db()
			.update(videos)
			.set({
				metadata: {
					...metadata,
					aiGenerationStatus: "QUEUED",
				},
			})
			.where(eq(videos.id, videoId));

		if (canUseWorkflowEngine()) {
			await start(generateAiWorkflow, [{ videoId, userId }]);
		} else {
			executeDirectAiGeneration({ videoId, userId }).catch((err) => {
				console.error("[generate-ai] Direct AI generation failed:", err);
				db()
					.update(videos)
					.set({
						metadata: {
							...metadata,
							aiGenerationStatus: "ERROR",
						},
					})
					.where(eq(videos.id, videoId))
					.catch(() => {});
			});
		}

		return {
			success: true,
			message: "AI generation started",
		};
	} catch {
		await db()
			.update(videos)
			.set({
				metadata: {
					...metadata,
					aiGenerationStatus: "ERROR",
				},
			})
			.where(eq(videos.id, videoId));

		return {
			success: false,
			message: "Failed to start AI generation",
		};
	}
}

const MAX_CHARS_PER_CHUNK = 24000;

interface VttSegment {
	start: number;
	text: string;
}

function parseVttWithTimestamps(vttContent: string): VttSegment[] {
	const lines = vttContent.split("\n");
	const segments: VttSegment[] = [];
	let currentStart = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim() ?? "";
		if (line.includes("-->")) {
			const timeMatch = line.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
			if (timeMatch) {
				currentStart =
					parseInt(timeMatch[1] ?? "0", 10) * 3600 +
					parseInt(timeMatch[2] ?? "0", 10) * 60 +
					parseInt(timeMatch[3] ?? "0", 10);
			}
		} else if (
			line &&
			line !== "WEBVTT" &&
			!/^\d+$/.test(line) &&
			!line.includes("-->")
		) {
			segments.push({ start: currentStart, text: line });
		}
	}

	return segments;
}

function chunkTranscriptWithTimestamps(
	segments: VttSegment[],
): { text: string; startTime: number; endTime: number }[] {
	const chunks: { text: string; startTime: number; endTime: number }[] = [];
	let currentChunk: VttSegment[] = [];
	let currentLength = 0;

	for (const segment of segments) {
		if (
			currentLength + segment.text.length > MAX_CHARS_PER_CHUNK &&
			currentChunk.length > 0
		) {
			chunks.push({
				text: currentChunk.map((s) => s.text).join(" "),
				startTime: currentChunk[0]?.start ?? 0,
				endTime: currentChunk[currentChunk.length - 1]?.start ?? 0,
			});
			currentChunk = [];
			currentLength = 0;
		}
		currentChunk.push(segment);
		currentLength += segment.text.length + 1;
	}

	if (currentChunk.length > 0) {
		chunks.push({
			text: currentChunk.map((s) => s.text).join(" "),
			startTime: currentChunk[0]?.start ?? 0,
			endTime: currentChunk[currentChunk.length - 1]?.start ?? 0,
		});
	}

	return chunks;
}

function getVideoDuration(segments: VttSegment[]): number {
	if (segments.length === 0) return 0;
	const lastSegment = segments[segments.length - 1];
	return lastSegment ? lastSegment.start + 3 : 0;
}

function clampChapters(
	chapters: { title: string; start: number }[],
	videoDuration: number,
): { title: string; start: number }[] {
	const filtered = chapters.filter((ch) => ch.start < videoDuration);

	if (filtered.length === 0 && chapters.length > 0) {
		const first = chapters[0];
		return first ? [{ title: first.title, start: 0 }] : [];
	}

	const minGap = Math.max(5, Math.floor(videoDuration / 10));
	const deduped: { title: string; start: number }[] = [];
	for (const chapter of filtered) {
		const last = deduped[deduped.length - 1];
		if (!last || Math.abs(chapter.start - last.start) >= minGap) {
			deduped.push(chapter);
		}
	}

	return deduped;
}

async function callAiApi(
	prompt: string,
	groqClient: ReturnType<typeof getGroqClient>,
): Promise<string> {
	if (groqClient) {
		try {
			const completion = await groqClient.chat.completions.create({
				messages: [{ role: "user", content: prompt }],
				model: GROQ_MODEL,
			});
			return completion.choices?.[0]?.message?.content || "{}";
		} catch (groqError) {
			if (serverEnv().OPENAI_API_KEY) {
				return callOpenAi(prompt);
			}
			throw groqError;
		}
	} else if (serverEnv().OPENAI_API_KEY) {
		return callOpenAi(prompt);
	}
	return "{}";
}

async function callOpenAi(prompt: string): Promise<string> {
	const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${serverEnv().OPENAI_API_KEY}`,
		},
		body: JSON.stringify({
			model: "gpt-4o-mini",
			messages: [{ role: "user", content: prompt }],
		}),
	});
	if (!aiRes.ok) {
		const errorText = await aiRes.text();
		throw new Error(`OpenAI API error: ${aiRes.status} ${errorText}`);
	}
	const aiJson = await aiRes.json();
	return aiJson.choices?.[0]?.message?.content || "{}";
}

function cleanJsonResponse(content: string): string {
	if (content.includes("```json")) {
		return content.replace(/```json\s*/g, "").replace(/```\s*/g, "");
	}
	if (content.includes("```")) {
		return content.replace(/```\s*/g, "");
	}
	return content;
}

function parseAiResponse(content: string): {
	title?: string;
	summary?: string;
	chapters?: { title: string; start: number }[];
} {
	try {
		const data = JSON.parse(cleanJsonResponse(content).trim());
		const chapters = Array.isArray(data.chapters)
			? data.chapters
					.filter(
						(ch: { start?: number }) =>
							typeof ch.start === "number" && ch.start >= 0,
					)
					.sort(
						(a: { start: number }, b: { start: number }) => a.start - b.start,
					)
			: [];
		return { title: data.title, summary: data.summary, chapters };
	} catch {
		return {
			title: "Generated Title",
			summary:
				"The AI was unable to generate a proper summary for this content.",
			chapters: [],
		};
	}
}

async function executeDirectAiGeneration(opts: {
	videoId: Video.VideoId;
	userId: string;
}): Promise<void> {
	const { videoId, userId } = opts;

	const groqClient = getGroqClient();
	if (!groqClient && !serverEnv().OPENAI_API_KEY) {
		throw new Error("Missing Groq or OpenAI API key");
	}

	const query = await db()
		.select({ video: videos, bucket: s3Buckets })
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.where(eq(videos.id, videoId));

	if (query.length === 0 || !query[0]?.video) {
		throw new Error("Video does not exist");
	}

	const { video, bucket } = query[0];
	const metadata = (video.metadata as VideoMetadata) || {};
	const bucketId = (bucket?.id ?? null) as S3Bucket.S3BucketId | null;

	if (video.transcriptionStatus !== "COMPLETE") {
		throw new Error("Transcription not complete");
	}

	if (metadata.summary && metadata.chapters) {
		throw new Error("AI metadata already generated");
	}

	await db()
		.update(videos)
		.set({
			metadata: { ...metadata, aiGenerationStatus: "PROCESSING" },
		})
		.where(eq(videos.id, videoId));

	const vtt = await Effect.gen(function* () {
		const [b] = yield* S3Buckets.getBucketAccess(Option.fromNullable(bucketId));
		return yield* b.getObject(`${userId}/${videoId}/transcription.vtt`);
	}).pipe(runPromise);

	if (Option.isNone(vtt)) {
		await db()
			.update(videos)
			.set({
				metadata: { ...metadata, aiGenerationStatus: "SKIPPED" },
			})
			.where(eq(videos.id, videoId));
		return;
	}

	const segments = parseVttWithTimestamps(vtt.value);
	const text = segments
		.map((s) => s.text)
		.join(" ")
		.trim();

	if (text.length < 10) {
		await db()
			.update(videos)
			.set({
				metadata: { ...metadata, aiGenerationStatus: "SKIPPED" },
			})
			.where(eq(videos.id, videoId));
		return;
	}

	const videoDuration = getVideoDuration(segments);
	const chunks = chunkTranscriptWithTimestamps(segments);

	let aiResult: {
		title?: string;
		summary?: string;
		chapters?: { title: string; start: number }[];
	};

	if (chunks.length === 1) {
		const transcriptWithTimestamps = segments
			.map(
				(s) =>
					`[${Math.floor(s.start / 60)}:${String(s.start % 60).padStart(2, "0")}] ${s.text}`,
			)
			.join("\n");

		const prompt = `You are Cap AI, an expert at analyzing video content. The video is ${videoDuration} seconds long. Analyze this timestamped transcript and provide JSON:
{"title": "string", "summary": "string (detailed, 1st person if presenting)", "chapters": [{"title": "string", "start": number}]}
All chapter "start" values MUST be between 0 and ${videoDuration}. Return ONLY valid JSON.
Transcript:
${transcriptWithTimestamps}`;

		const content = await callAiApi(prompt, groqClient);
		aiResult = parseAiResponse(content);
	} else {
		const chunkSummaries: {
			summary: string;
			keyPoints: string[];
			chapters: { title: string; start: number }[];
		}[] = [];

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			if (!chunk) continue;

			const chunkPrompt = `You are Cap AI. This is section ${i + 1} of ${chunks.length} from a ${videoDuration}s video (${Math.floor(chunk.startTime / 60)}:${String(chunk.startTime % 60).padStart(2, "0")} to ${Math.floor(chunk.endTime / 60)}:${String(chunk.endTime % 60).padStart(2, "0")}).
Provide JSON: {"summary": "string", "keyPoints": ["string"], "chapters": [{"title": "string", "start": number}]}
Chapter "start" values MUST be between ${chunk.startTime} and ${chunk.endTime}. Return ONLY valid JSON.
Transcript:
${chunk.text}`;

			const chunkContent = await callAiApi(chunkPrompt, groqClient);
			try {
				const parsed = JSON.parse(cleanJsonResponse(chunkContent).trim());
				chunkSummaries.push({
					summary: parsed.summary || "",
					keyPoints: parsed.keyPoints || [],
					chapters: parsed.chapters || [],
				});
			} catch {}
		}

		const allChapters: { title: string; start: number }[] = [];
		const sortedChapters = chunkSummaries
			.flatMap((c) => c.chapters)
			.sort((a, b) => a.start - b.start);
		const minGap = Math.max(5, Math.floor(videoDuration / 10));
		for (const chapter of sortedChapters) {
			const lastChapter = allChapters[allChapters.length - 1];
			if (
				!lastChapter ||
				Math.abs(chapter.start - lastChapter.start) >= minGap
			) {
				allChapters.push(chapter);
			}
		}

		const sectionDetails = chunkSummaries
			.map((c, i) => `Section ${i + 1}: ${c.summary}`)
			.join("\n\n");

		const finalPrompt = `You are Cap AI. Synthesize these section analyses into a comprehensive summary.
${sectionDetails}
Provide JSON: {"title": "string", "summary": "string (comprehensive, detailed)"}
Return ONLY valid JSON.`;

		const finalContent = await callAiApi(finalPrompt, groqClient);
		try {
			const parsed = JSON.parse(cleanJsonResponse(finalContent).trim());
			aiResult = {
				title: parsed.title,
				summary: parsed.summary,
				chapters: allChapters,
			};
		} catch {
			aiResult = {
				title: "Video Summary",
				summary: chunkSummaries
					.map((c, i) => `Part ${i + 1}: ${c.summary}`)
					.join("\n\n"),
				chapters: allChapters,
			};
		}
	}

	if (aiResult.chapters) {
		aiResult.chapters = clampChapters(aiResult.chapters, videoDuration);
	}

	const updatedMetadata: VideoMetadata = {
		...metadata,
		aiTitle: aiResult.title || metadata.aiTitle,
		summary: aiResult.summary || metadata.summary,
		chapters: aiResult.chapters || metadata.chapters,
		aiGenerationStatus: "COMPLETE",
	};

	await db()
		.update(videos)
		.set({ metadata: updatedMetadata })
		.where(eq(videos.id, videoId));

	const hasDatePattern = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(
		video.name || "",
	);

	if (
		(video.name?.startsWith("Cap Recording -") || hasDatePattern) &&
		aiResult.title
	) {
		await db()
			.update(videos)
			.set({ name: aiResult.title })
			.where(eq(videos.id, videoId));
	}
}
