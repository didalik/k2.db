// db/public/requestor/lib/util.mjs -- a copy of the root k2 repo's own
// lib/util.mjs (just the Channel/Semaphore pair job.ts needs), kept here so
// db/public alone (cloned standalone, no other repo) has everything `make
// requestor` needs. Not db/public's own top-level lib/util.mjs (that one's
// unrelated -- a browser-side keyboard/console helper for intro.mjs). Keep
// in sync with the original by hand if it changes.

class Semaphore { // {{{1
  // Source: {{{2
  // https://github.com/jsoendermann/semaphore-async-await

  #permits // {{{2
  #promiseResolverQueue

  constructor (permits) { // {{{2
    this.#permits = permits
    this.#promiseResolverQueue = []
  }

  acquire () { // {{{2
    return this.wait();
  }

  /** drainPermits {{{2
   * Acquires all permits that are currently available and returns the number
   * of acquired permits.
   * @returns  Number of acquired permits.
   */
  drainPermits () {
    if (this.#permits > 0) {
      const permitCount = this.#permits;
      this.#permits = 0;
      return permitCount;
    }

    return 0;
  }

  /** async execute {{{2
   * Schedules func to be called once a permit becomes available.
   * Returns a promise that resolves to the return value of func.
   * @param func  The function to be executed.
   * @return  A promise that gets resolved with the return value of the function.
   */
  async execute (func) {

    //console.log(this.#promiseResolverQueue.length, this.#permits, func)

    await this.wait();
    try {
      return await func();
    } catch(e) {
      console.error(e)
      alert(e)
    } finally {

      //console.log(this.#promiseResolverQueue.length, this.#permits, 'DONE', func)

      this.signal();
    }
  }

  getPermits () { // {{{2
    return this.#permits;
  }

  /** release {{{2
   * Alias for this.signal.
   */
  release () {
    //console.log('Semaphore.release'); console.trace()

    this.signal();
    return true;
  }

  /** signal {{{2
   * Increases the number of permits by one. If there are other functions waiting,
   * one of them will continue to execute in a future iteration of the event loop.
   */
  signal () {
    this.#permits += 1;

    if (this.#permits > 1 && this.#promiseResolverQueue.length > 0) {
      throw new Error(
        'Semaphore.permits should never be > 0 when there is someone waiting.'
      );
    } else if (this.#permits === 1 && this.#promiseResolverQueue.length > 0) {
      // If there is someone else waiting, immediately consume the permit that was
      // released at the beginning of this function and let the waiting function
      // resume.
      this.#permits -= 1;

      const nextResolver = this.#promiseResolverQueue.shift();
      if (nextResolver) {
        nextResolver(true);
      }
    }
  }

  toJso () { // {{{2
    return { agents: this.#permits, users: this.#promiseResolverQueue.length };
  }

  /** tryAcquire {{{2
   * Synchronous function that tries to acquire a permit and returns
   * true if successful, false otherwise.
   * @returns  Whether a permit could be acquired.
   */
  tryAcquire () {
    if (this.#permits > 0) {
      this.#permits -= 1;
      return true;
    }

    return false;
  }

  wait () { // {{{2
    if (this.#permits > 0) {
      this.#permits -= 1;
      return Promise.resolve(true);
    }

    // If there is no permit available, we return a promise that resolves
    // once the semaphore gets signaled enough times that permits is equal to one.
    return new Promise(resolver => this.#promiseResolverQueue.push(resolver));
  }

  /** async waitFor {{{2
   * Same as this.wait except the promise returned gets resolved with false if no
   * permit becomes available in time.
   * @param milliseconds  The time spent waiting before the wait is aborted.
   * This is a lower bound, you shouldn't rely on it being precise.
   * @returns  A promise that gets resolved to true when execution is allowed to
   * proceed or false if the time given elapses before a permit becomes available.
   */
  async waitFor (milliseconds) {
    if (this.#permits > 0) {
      this.#permits -= 1;
      return Promise.resolve(true);
    }

    // We save the resolver function in the current scope so that we can
    // resolve the promise to false if the time expires. TODO use reject instead?
    let resolver
    const promise = new Promise(r => { resolver = r })

    // The saved resolver gets added to our list of promise resolvers so that it gets
    // a chance to be resolved as a result of a call to signal().
    this.#promiseResolverQueue.push(resolver);

    setTimeout(() => {
      // We have to remove the promise resolver from our list. Resolving it twice
      // would not be an issue but signal() always takes the next resolver from the
      // queue and resolves it which would swallow a permit if we didn't remove it.
      const index = this.#promiseResolverQueue.indexOf(resolver);
      if (index !== -1) {
        this.#promiseResolverQueue.splice(index, 1);
      } else {
        // This shouldn't happen, not much we can do at this point
        throw new Error(
          `Semaphore.waitFor couldn't find its promise resolver in the queue`
        );
      }

      // Resolve to false because the wait was unsuccessful.
      resolver(false);
    }, milliseconds);

    return promise;
  }

  // }}}2
}

class Channel { // {{{1
  // See also: https://en.wikipedia.org/wiki/Semaphore_(programming), Producer–consumer problem {{{2

  #emptyCount // {{{2
  #fullCount
  #queue
  #useQueue

  constructor (emptyCount = 99, fullCount = 0, queue = [], useQueue = 1) { // {{{2
    this.#emptyCount = new Semaphore(emptyCount)
    this.#fullCount = new Semaphore(fullCount)
    this.#queue = queue
    this.#useQueue = new Semaphore(useQueue)
  }

  receive () { // {{{2
    return this.#fullCount.wait().then(_ => // P(fullCount)
      this.#useQueue.wait()                 // P(useQueue)
    ).then(_ => {
      let s = this.#queue.shift()           // item ← getItemFromQueue()
      this.#emptyCount.signal()             // V(emptyCount)
      this.#useQueue.signal()               // V(useQueue)
      return Promise.resolve(s);
    });
  }

  send (item) { // {{{2
    return this.#emptyCount.wait().     // P(emptyCount)
      then(_ => this.#useQueue.wait()). // P(useQueue)
      then(_ => {
        this.#queue.push(item)          // putItemIntoQueue(item)
        this.#useQueue.signal()         // V(useQueue)
        this.#fullCount.signal()        // V(fullCount)
        return Promise.resolve(true);
      });
  }

  // }}}2
}

export { // {{{1
  Channel,
};
