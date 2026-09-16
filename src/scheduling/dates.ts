import moment, { Moment } from "moment";

import { ALLOWED_DATE_FORMATS, PREFERRED_DATE_FORMAT } from "src/scheduling/constants";

export function formatDate(ticks: number, format: string = PREFERRED_DATE_FORMAT): string {
    const d = new Date(ticks);
    let result = format;
    result = result.replaceAll(/YYYY/g, d.getFullYear().toString().padStart(4, "0"));
    result = result.replaceAll(/MM/g, (d.getMonth() + 1).toString().padStart(2, "0"));
    result = result.replaceAll(/DD/g, d.getDate().toString().padStart(2, "0"));
    return result;
}

export interface IDayBoundary {
    hour: number;
    minute: number;
    second: number;
}

export interface IDateProvider {
    get now(): Moment;
    get today(): Moment;
    getDayBoundary(): IDayBoundary | null;
    setDayBoundary(dayBoundary: IDayBoundary | null): void;
}

export class LiveDateProvider implements IDateProvider {
    private dayBoundary: IDayBoundary | null = null;

    get now(): Moment {
        return moment();
    }

    get today(): Moment {
        if (
            this.dayBoundary &&
            !(
                this.dayBoundary.hour === 0 &&
                this.dayBoundary.minute === 0 &&
                this.dayBoundary.second === 0
            )
        ) {
            const nowTime = moment();
            const customBoundary = moment()
                .hour(this.dayBoundary.hour)
                .minute(this.dayBoundary.minute)
                .second(this.dayBoundary.second)
                .millisecond(0);
            if (nowTime.isBefore(customBoundary)) {
                return moment().startOf("day").subtract(1, "day");
            }
        }
        return moment().startOf("day");
    }

    getDayBoundary(): IDayBoundary | null {
        return this.dayBoundary;
    }

    setDayBoundary(dayBoundary: IDayBoundary | null): void {
        this.dayBoundary = dayBoundary;
    }
}

export class StaticDateProvider implements IDateProvider {
    private m: Moment;
    private dayBoundary: IDayBoundary | null = null;

    constructor(m: Moment) {
        this.m = m;
    }

    get now(): Moment {
        return this.m.clone();
    }

    get today(): Moment {
        return this.m.clone().startOf("day");
    }

    static fromDateStr(str: string): StaticDateProvider {
        return new StaticDateProvider(DateUtil.dateStrToMoment(str));
    }

    getDayBoundary(): IDayBoundary | null {
        return this.dayBoundary;
    }

    setDayBoundary(dayBoundary: IDayBoundary | null): void {
        this.dayBoundary = dayBoundary;
    }
}

export class DateUtil {
    static dateStrToMoment(str: string): Moment {
        return moment(str, ALLOWED_DATE_FORMATS);
    }

    static strToDayBoundary(str: string): IDayBoundary | null {
        const parts = str.split(":");
        if (parts.length !== 3) return null;
        const hour = parseInt(parts[0] ?? "");
        const minute = parseInt(parts[1] ?? "");
        const second = parseInt(parts[2] ?? "");
        if (
            isNaN(hour) || hour < 0 || hour > 23 ||
            isNaN(minute) || minute < 0 || minute > 59 ||
            isNaN(second) || second < 0 || second > 59
        ) return null;
        return { hour, minute, second };
    }
}

export let globalDateProvider: IDateProvider = new LiveDateProvider();

export function setupStaticDateProvider(dateStr: string): void {
    globalDateProvider = StaticDateProvider.fromDateStr(dateStr);
}

export function setupStaticDateProvider20230906(): void {
    setupStaticDateProvider("2023-09-06");
}
