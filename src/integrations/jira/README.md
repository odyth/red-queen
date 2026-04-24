# Jira Issue Tracker Adapter

Red Queen integration for Atlassian Jira Cloud — implements the
`IssueTracker` interface via the Jira REST API (v3).

## Configuration

```yaml
issueTracker:
  type: jira
  config:
    baseUrl: https://yourco.atlassian.net
    email: you@yourco.com
    apiToken: ${JIRA_TOKEN}
    cloudId: a7fa29d9-... # for webhook tenant validation (optional)
    projectKey: RQ
    customFields:
      phase: customfield_10158
      spec: customfield_10157
    phaseMapping:
      spec-writing: { optionId: "10054", label: "Prompt Writing" }
      spec-review: { optionId: "10055", label: "Prompt Review" }
      coding: { optionId: "10056", label: "Coding" }
      code-review: { optionId: "10057", label: "Code Review" }
      testing: { optionId: "10058", label: "Testing" }
      human-review: { optionId: "10059", label: "Human Review" }
      spec-feedback: { optionId: "10060", label: "Addressing Feedback" }
      code-feedback: { optionId: "10060", label: "Addressing Feedback" }
      blocked: { optionId: "10061", label: "Blocked" }
    statusTransitions:
      inProgress: "In Progress"
      done: "Done"
    botAccountId: 712020:... # optional; auto-fetched if absent
    webhookSecret: ${JIRA_WEBHOOK_SECRET}
```

Secrets in `.env`:

```
JIRA_TOKEN=...
JIRA_WEBHOOK_SECRET=...
```

## Generating an API token

1. Go to <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. Create a new token for the Atlassian account Red Queen will run as.
3. Put the token into `JIRA_TOKEN` in your `.env`.

The adapter uses API-token basic auth (`email:apiToken`). OAuth 2.0
is out of scope for Phase 5.

### Using a dedicated bot account

Create a dedicated Atlassian user (e.g., `alicebot@yourco.com`), grant
it the same project roles you want the bot to have, and generate its
API token. The code path is identical to using your own token — Atlassian
doesn't distinguish "bot" from "user" accounts at the API level.

## Finding your cloud ID

```
curl -s https://<yourco>.atlassian.net/_edge/tenant_info
```

Returns `{"cloudId": "...", ...}`.

## Finding custom field IDs

The easiest way:

```
curl -u "$EMAIL:$JIRA_TOKEN" https://<yourco>.atlassian.net/rest/api/3/field \
  | jq '.[] | select(.name == "AI Phase")'
```

Note the `id` field (e.g., `customfield_10158`).

Do the same for your spec text field (e.g., "Prompt" or "Acceptance
Criteria").

## Finding phase option IDs

On a sample issue you've already configured:

```
curl -u "$EMAIL:$JIRA_TOKEN" \
  "https://<yourco>.atlassian.net/rest/api/3/issue/RQ-1/editmeta" \
  | jq '.fields["customfield_10158"].allowedValues[] | {id, value}'
```

Returns the list of option IDs and their labels. Map each Red Queen
phase to the matching `id`.

## Webhook setup

Webhooks reduce polling latency but are **optional** — Red Queen's
poller keeps things working without them.

1. In Jira: **Settings → System → Webhooks → Create webhook**.
2. URL: `<red-queen-public-url>/webhook/issue-tracker`.
3. Events: `Issue: updated`.
4. JQL: `project = "RQ"` (restrict to your project).
5. Secret: put the same string in `JIRA_WEBHOOK_SECRET`.
6. **Note**: admin access to the Jira site is required to register
   webhooks. If you can't, stick with polling.

## Self-hosted Jira Server / Data Center

Out of scope for Phase 5. The API surface overlaps with Cloud but the
adapter has not been validated against it. Unofficial port is plausible.

## ADF

The adapter ships a hand-rolled markdown↔ADF converter that supports
paragraphs, code blocks, hard breaks, inline code, links, and mentions.
Unknown node types are tolerated on read (text descendants are
concatenated).

If a skill produces output that doesn't round-trip through the
converter cleanly, raise an issue — but in practice the converter
handles the outputs of every Red Queen skill.

## Known limitations (Phase 5)

- Single Jira cloud / single project per Red Queen instance.
- No OAuth 2.0 — API-token basic auth only.
- No automatic creation of custom fields or phase options — the
  Jira admin UI is used for one-time setup.
- ADF is write-first; read path is approximate.
