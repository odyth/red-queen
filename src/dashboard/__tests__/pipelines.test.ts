import { describe, expect, it } from "vitest";
import { renderPipelines } from "../client/pipelines.js";
import type { PipelineWire } from "../shared/api-types.js";

describe("renderPipelines", () => {
  it("escapes issue, phase, repo, and branch text instead of creating markup", () => {
    const html = renderPipelines([
      {
        issueId: '<img src=x onerror="alert(1)">',
        currentPhase: "review<&>",
        updatedAt: "2026-09-13T00:00:00.000Z",
        repos: [
          {
            repo: '<svg onload="alert(2)">',
            inScope: true,
            branchName: 'feature/<script>alert("x")</script>&',
            prNumber: 3,
            orphaned: false,
          },
        ],
      },
    ]);

    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("review&lt;&amp;&gt;");
    expect(html).toContain("&lt;svg onload=&quot;alert(2)&quot;&gt;");
    expect(html).toContain("feature/&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;");
    expect(html).not.toMatch(/<(?:img|svg|script)\b/i);
  });

  it("shows scope on every row, adds orphaned independently, and handles null values", () => {
    const pipeline: PipelineWire = {
      issueId: "PROJ-1",
      currentPhase: null,
      updatedAt: "2026-09-13T00:00:00.000Z",
      repos: [
        { repo: "api", inScope: true, branchName: "feature/1", prNumber: 4, orphaned: false },
        { repo: "web", inScope: false, branchName: "feature/1", prNumber: 5, orphaned: true },
        { repo: "idle", inScope: false, branchName: null, prNumber: null, orphaned: false },
      ],
    };
    const html = renderPipelines([pipeline]);

    expect(html).toContain(
      '<strong>api</strong> · feature/1 · PR #4 · <span class="muted">in-scope</span>',
    );
    expect(html).toContain(
      '<strong>web</strong> · feature/1 · PR #5 · <span class="muted">descoped</span> · <span class="err">orphaned</span>',
    );
    expect(html).toContain('<strong>idle</strong> · — · — · <span class="muted">descoped</span>');
    expect(html).toContain('<strong>PROJ-1</strong> <span class="muted">—</span>');
    expect(html.match(/orphaned/g)).toHaveLength(1);
    expect(html).not.toContain("null");
  });

  it("renders an empty state without pipeline data", () => {
    expect(renderPipelines([])).toBe('<li class="empty">(none)</li>');
    expect(renderPipelines(null)).toBe('<li class="empty">(none)</li>');
  });
});
