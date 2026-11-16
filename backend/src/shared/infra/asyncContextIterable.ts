/**
 * Runs `createIterable`, and every step of the iterator it returns, inside `enter`. An async
 * generator resumes in whatever async context calls `next()`, so an `AsyncLocalStorage` store
 * that `enter` sets reaches the generator's body only when each step runs inside it too.
 */
export const runAsyncIterableWithin = async function* <T>(
  enter: <R>(run: () => R) => R,
  createIterable: () => AsyncIterable<T>,
): AsyncIterable<T> {
  const iterator = enter(() => createIterable()[Symbol.asyncIterator]());
  let completed = false;
  try {
    while (true) {
      const step = await enter(() => iterator.next());
      if (step.done) {
        completed = true;
        return;
      }
      yield step.value;
    }
  } finally {
    if (!completed && iterator.return) {
      await enter(() => iterator.return!());
    }
  }
};
