import test from "node:test";
import assert from "node:assert/strict";
import { escapeSlackText, buildIssueMessage } from "./slack/slack.utils.js";
import { escapeDiscordText, buildIssueEmbed } from "./discord/discord.utils.js";

// The audit's payload: an issue title that renders as a clickable link posted
// by the Trussen bot into a company channel.
const SLACK_PAYLOAD = "<https://evil.example|Action required: re-authenticate Slack>";
const DISCORD_PAYLOAD = "[Action required: re-authenticate](https://evil.example)";

test("a Slack link in an issue title is neutralised (F-30)", () => {
  const escaped = escapeSlackText(SLACK_PAYLOAD);
  assert.equal(escaped.includes("<https"), false, "link syntax survived");
  assert.ok(escaped.includes("&lt;") && escaped.includes("&gt;"));
});

test("the payload does not reach a built Slack message", () => {
  const msg = buildIssueMessage({
    emoji: ":bug:", title: "Issue created", issueId: "ACME-1",
    issueTitle: SLACK_PAYLOAD, fields: [{ label: "Project", value: SLACK_PAYLOAD }],
    frontendUrl: "https://app.trussen.app",
  });
  const rendered = JSON.stringify(msg);

  // The attacker's TEXT may still appear — it is a title, after all. What must
  // not survive is the unescaped `<...|...>` that makes Slack render a link.
  assert.equal(/<https:\/\/evil\.example/.test(rendered), false, "an unescaped link survived");
  assert.ok(rendered.includes("&lt;https://evil.example"), "payload was not escaped");

  // ...while the app's own link, built from trusted values, still works.
  assert.ok(rendered.includes("<https://app.trussen.app/issues/ACME-1|ACME-1>"));
});

test("Slack escaping is ordered so & is not double-escaped", () => {
  assert.equal(escapeSlackText("R&D <tag>"), "R&amp;D &lt;tag&gt;");
});

test("Slack formatting characters are left alone deliberately", () => {
  // Escaping these would mangle ordinary titles; they only produce bold/italic.
  assert.equal(escapeSlackText("fix_the_thing *now*"), "fix_the_thing *now*");
});

test("a Discord markdown link in an issue title is neutralised (F-30)", () => {
  const embed = buildIssueEmbed({
    title: "Issue created", issueId: "ACME-1", issueTitle: DISCORD_PAYLOAD,
    color: 1, fields: [{ name: "Project", value: DISCORD_PAYLOAD }],
  });
  const rendered = JSON.stringify(embed);
  assert.equal(rendered.includes("](https://evil.example)"), false, "link syntax survived");
});

test("Discord escaping never leaves a dangling backslash at the truncation point", () => {
  // Truncating after escaping could cut a "\\x" pair in half and escape the
  // ellipsis instead. Escaping happens after truncation for this reason.
  const embed = buildIssueEmbed({
    title: "t", issueId: "ACME-1", issueTitle: "[".repeat(400),
    color: 1, fields: [],
  });
  assert.ok(embed.description!.endsWith("..."), `unexpected tail: ${embed.description!.slice(-8)}`);
});
