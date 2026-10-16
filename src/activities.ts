// Activities: the "real work" units a workflow can invoke.
// Unlike workflow code, activities can do I/O
// (HTTP calls, DB, whatever) and Temporal automatically retries them on failure.

export async function greet(name: string): Promise<string> {
  return `Hello, ${name}! Processed at ${new Date().toISOString()}`;
}
