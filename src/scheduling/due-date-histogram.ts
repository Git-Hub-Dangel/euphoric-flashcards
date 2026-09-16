export class DueDateHistogram {
    public static dueNowNDays: number = 0;
    dueDatesMap: Map<number, number> = new Map<number, number>();

    constructor(rec: Record<number, number> | null = null) {
        this.dueDatesMap = new Map<number, number>();
        if (rec !== null && rec !== undefined) {
            Object.entries(rec).forEach(([key, value]) => {
                this.dueDatesMap.set(Number(key), value);
            });
        }
    }

    get dueNotesCount(): number {
        return this.dueDatesMap.get(DueDateHistogram.dueNowNDays) ?? 0;
    }

    hasEntryForDays(days: number): boolean {
        return this.dueDatesMap.has(days);
    }

    set(days: number, value: number): void {
        this.dueDatesMap.set(days, value);
    }

    get(days: number): number {
        return this.dueDatesMap.get(days) ?? 0;
    }

    increment(days: number): void {
        this.dueDatesMap.set(days, (this.dueDatesMap.get(days) ?? 0) + 1);
    }

    decrement(days: number): void {
        const value = this.dueDatesMap.get(days) ?? 0;
        if (value > 0) this.dueDatesMap.set(days, value - 1);
    }

    findLeastUsedIntervalOverRange(originalInterval: number, fuzz: number): number {
        if (!this.hasEntryForDays(originalInterval)) {
            return originalInterval;
        }
        let interval = originalInterval;
        outer: for (let i = 1; i <= fuzz; i++) {
            for (const ivl of [originalInterval - i, originalInterval + i]) {
                if (!this.hasEntryForDays(ivl)) {
                    interval = ivl;
                    break outer;
                }
                if ((this.dueDatesMap.get(ivl) ?? 0) < (this.dueDatesMap.get(interval) ?? 0)) {
                    interval = ivl;
                }
            }
        }
        return interval;
    }
}
