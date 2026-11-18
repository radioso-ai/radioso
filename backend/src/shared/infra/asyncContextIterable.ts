/**
 * Runs `createIterable`, and every step of the iterator it returns, inside `enter`. An async
 * generator resumes in whatever async context calls `next()`, so an `AsyncLocalStorage` store
 * that `enter` sets reaches the generator's body only when each step runs inside it too. The
 * iterator's return value is passed through, so a generator that settles to a result keeps it.
 */
export const runAsyncIterableWithin = async function* <T, TReturn = void>(
  enter: <R>(run: () => R) => R,
  createIterable: () => AsyncIterable<T, TReturn>,
): AsyncGenerator<T, TReturn> {
  const iterator = enter(() => createIterable()[Symbol.asyncIterator]());
  let completed = false;
  try {
    while (true) {
      const step = await enter(() => iterator.next());
      if (step.done) {
        completed = true;
        return step.value;
      }
      yield step.value;
    }
  } finally {
    if (!completed && iterator.return) {
      await enter(() => iterator.return!());
    }
  }
};
