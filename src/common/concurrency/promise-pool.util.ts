/**
 * 간단한 Promise 풀 구현
 * - 입력 배열을 주어진 동시성으로 처리하고, 결과를 원래 순서로 돌려준다.
 */
export async function runWithConcurrency<TInput, TResult>(
  inputs: readonly TInput[],
  concurrency: number,
  worker: (input: TInput, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (inputs.length === 0) return [];
  const effectiveConcurrency = Math.max(1, Math.min(concurrency, inputs.length));
  const results = new Array<TResult>(inputs.length);
  let cursor = 0;

  async function runner(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= inputs.length) break;
      results[index] = await worker(inputs[index], index);
    }
  }

  const runners = Array.from({ length: effectiveConcurrency }, runner);
  await Promise.all(runners);
  return results;
}
