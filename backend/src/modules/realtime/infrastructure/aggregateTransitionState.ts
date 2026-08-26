/**
 * Serializes local decrements into exact Redis CAS steps. A lost 5→4 reply may
 * be replayed, but later local releases must still apply 4→3→2→… individually.
 */
export class AggregateTransitionState {
  private readonly pendingTargets: number[] = [];
  private _localDesired = 0;
  private _redisExpected = 0;
  private _fenced = false;

  get localDesired(): number { return this._localDesired; }
  get redisExpected(): number { return this._redisExpected; }
  get fenced(): boolean { return this._fenced; }
  get hasPending(): boolean { return this.pendingTargets.length > 0; }
  get nextTarget(): number | undefined { return this.pendingTargets[0]; }

  acquired(): number {
    this._localDesired += 1;
    this._redisExpected = this._localDesired;
    return this._localDesired;
  }

  released(): number | undefined {
    if (this._localDesired === 0) return undefined;
    this._localDesired -= 1;
    const previousTarget = this.pendingTargets.at(-1) ?? this._redisExpected;
    const target = Math.max(0, previousTarget - 1);
    this.pendingTargets.push(target);
    return target;
  }

  releaseLocallyAfterFence(): number | undefined {
    if (this._localDesired === 0) return undefined;
    this._localDesired -= 1;
    this.pendingTargets.length = 0;
    return this._localDesired;
  }

  acknowledgeStep(): void {
    const target = this.pendingTargets.shift();
    if (target === undefined) throw new Error("No aggregate transition to acknowledge");
    this._redisExpected = target;
  }

  fence(): void { this._fenced = true; this.pendingTargets.length = 0; }
}
