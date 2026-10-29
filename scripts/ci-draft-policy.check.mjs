import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const ci = readFileSync(
	new URL("../.github/workflows/ci.yml", import.meta.url),
	"utf8",
);
const job = (name) => {
	const match = ci.match(
		new RegExp(
			`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|(?![\\s\\S]))`,
			"m",
		),
	);
	assert.ok(match, `Missing ${name}`);
	return match[1];
};
const expression = (block, field) => {
	const match = block.match(new RegExp(`^    ${field}: (.+)$`, "m"));
	assert.ok(match, `Missing ${field}`);
	return match[1].replace(/^\$\{\{\s*|\s*\}\}$/g, "");
};
const evaluate = (value, event, draft) =>
	runInNewContext(value, {
		github: { event_name: event, event: { pull_request: { draft } } },
	});

test("Draft PRs fail closed; ready and push checks run", () => {
	assert.match(
		ci,
		/types: \[opened, synchronize, reopened, ready_for_review, converted_to_draft\]/,
	);
	const pending = job("draft-pending");
	assert.match(pending, /exit 1/);
	assert.equal(
		evaluate(expression(pending, "name"), "pull_request", true),
		"Typecheck",
	);
	assert.equal(evaluate(expression(pending, "if"), "pull_request", true), true);
	assert.equal(
		evaluate(expression(pending, "if"), "pull_request", false),
		false,
	);
	for (const name of [
		"changes",
		"typecheck",
		"format-biome",
		"format-rust",
		"lint-biome",
	]) {
		const condition = expression(job(name), "if");
		assert.equal(evaluate(condition, "pull_request", true), false, name);
		assert.equal(evaluate(condition, "pull_request", false), true, name);
		assert.equal(evaluate(condition, "push", false), true, name);
	}
	assert.match(job("typecheck"), /pnpm typecheck/);
	const selfHost = readFileSync(
		new URL("../.github/workflows/test-self-hosting.yml", import.meta.url),
		"utf8",
	);
	assert.match(selfHost, /ready_for_review/);
	assert.match(
		selfHost,
		/if: github.event_name != 'pull_request' \|\| github.event.pull_request.draft != true/,
	);
});
