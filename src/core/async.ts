export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`${label} timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        rejectPromise(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
