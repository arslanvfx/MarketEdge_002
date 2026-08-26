export type ScalperExitPreSubmitResult<T> =
  | { ready: true; value: T }
  | { ready: false; reason: string; evidence?: Record<string, unknown> };

export async function runClaimedScalperExitLifecycle<T>(handlers: {
  revalidate: () => Promise<ScalperExitPreSubmitResult<T>>;
  release: (blocked: { reason: string; evidence?: Record<string, unknown> }) => Promise<void>;
  claimRequest: (value: T) => Promise<boolean>;
  submit: (value: T) => Promise<void>;
}): Promise<"released" | "request_not_claimed" | "submitted"> {
  const validation = await handlers.revalidate();
  if (!validation.ready) {
    await handlers.release(validation);
    return "released";
  }
  if (!await handlers.claimRequest(validation.value)) return "request_not_claimed";
  await handlers.submit(validation.value);
  return "submitted";
}