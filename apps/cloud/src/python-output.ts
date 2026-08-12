const MAX_PYTHON_OUTPUT = 64 * 1024;

export type PythonExecutionOutput = {
  code?: string;
  executionCount?: number;
  logs: { stdout: string[]; stderr: string[] };
  results: Array<{
    text?: string;
    html?: string;
    png?: string;
    jpeg?: string;
    svg?: string;
    latex?: string;
    markdown?: string;
    json?: unknown;
    chart?: unknown;
    data?: unknown;
  }>;
  error?: { name: string; message: string; traceback: string[] };
};

export function formatPythonExecution(result: PythonExecutionOutput): string {
  const sections: string[] = [];
  if (result.logs.stdout.length) sections.push(result.logs.stdout.join("\n"));
  if (result.logs.stderr.length) sections.push(`stderr:\n${result.logs.stderr.join("\n")}`);
  for (const value of result.results) {
    if (value.text) sections.push(value.text);
    else if (value.markdown) sections.push(value.markdown);
    else if (value.json !== undefined) sections.push(JSON.stringify(value.json, null, 2));
    else if (value.data !== undefined) sections.push(JSON.stringify(value.data, null, 2));
    else if (value.chart !== undefined) sections.push(`Chart data:\n${JSON.stringify(value.chart)}`);
    else if (value.html) sections.push(`HTML result:\n${stripHtml(value.html)}`);
    else if (value.png || value.jpeg || value.svg) sections.push("A visual result was produced. Save charts to the durable workspace when they need to be reused or downloaded.");
    else if (value.latex) sections.push(value.latex);
  }
  if (result.error) {
    const traceback = result.error.traceback.join("\n");
    sections.push([`${result.error.name}: ${result.error.message}`, traceback].filter(Boolean).join("\n"));
  }
  return (sections.filter(Boolean).join("\n\n") || "Python completed without textual output.").slice(0, MAX_PYTHON_OUTPUT);
}

function stripHtml(value: string): string {
  return value.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
