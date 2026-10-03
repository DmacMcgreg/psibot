/**
 * Detect the Claude CLI's "model unavailable" startup failure.
 *
 * When the upstream rejects the requested model (404 "model not found", or
 * Z.AI's gateway intermittently erroring on a redirected/removed SKU — e.g.
 * glm-5.2 removed 2026-09-06, glm-5.3-flash flaking 2026-09-22), the CLI exits
 * CLEANLY and emits a result message whose text is the error itself. Naively
 * that looks like a successful run: subtype maps to end_turn, the fallback
 * ladder never advances, and the job records "success" containing an error
 * message (observed 2026-09-22, job #85).
 *
 * Guards keep this from hijacking legitimate answers that merely DISCUSS model
 * errors: the text must be short (CLI startup errors are one line) and the run
 * must have produced essentially no turns.
 */
export function isModelUnavailableResult(resultText: string, numTurns: number): boolean {
  if (!resultText || resultText.length > 400) return false;
  if (numTurns > 1) return false;
  return /issue with the selected model|may not exist or you may not have access|unknown model, please check the model code|model not found|model[\s\S]{0,60}not found|does not exist or you do not have access|invalid model/i.test(
    resultText,
  );
}
