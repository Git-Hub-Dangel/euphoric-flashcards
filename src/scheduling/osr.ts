import type { Moment } from "moment";

import { DUMMY_DUE_DATE_FOR_NEW_CARD, PREFERRED_DATE_FORMAT, TICKS_PER_DAY } from "src/scheduling/constants";
import { DateUtil, formatDate, globalDateProvider } from "src/scheduling/dates";
import { DueDateHistogram } from "src/scheduling/due-date-histogram";
import { ReviewResponse } from "src/scheduling/review-response";
import { EuphoricSettings } from "src/settings";

// schedule state

export class RepItemScheduleInfoOsr {
    public dueDate: Moment;
    public interval: number;
    public latestEase: number;
    public delayedBeforeReviewTicks: number;

    constructor(
        dueDate: Moment,
        interval: number,
        latestEase: number,
        delayedBeforeReviewTicks: number | null = null,
    ) {
        this.dueDate = dueDate;
        this.interval = interval;
        this.latestEase = latestEase;
        this.delayedBeforeReviewTicks =
            dueDate && delayedBeforeReviewTicks === null
                ? globalDateProvider.today.valueOf() - dueDate.valueOf()
                : delayedBeforeReviewTicks ?? 0;
    }

    static readonly dummyDueDateForNewCard: string = DUMMY_DUE_DATE_FOR_NEW_CARD;
    static readonly initialInterval: number = 1.0;

    isDue(): boolean {
        return this.dueDate != null && this.dueDate.isSameOrBefore(globalDateProvider.now);
    }

    get dueDateAsUnix(): number {
        return this.dueDate.valueOf();
    }

    formatDueDate(): string {
        return formatDate(this.dueDateAsUnix, PREFERRED_DATE_FORMAT);
    }

    delayedBeforeReviewDaysInt(): number {
        return Math.max(0, Math.floor(this.delayedBeforeReviewTicks / TICKS_PER_DAY));
    }

    formatScheduleAsSRHtmlComment(): string {
        const dateStr = this.dueDate
            ? this.formatDueDate()
            : RepItemScheduleInfoOsr.dummyDueDateForNewCard;
        return `!${dateStr},${this.interval},${this.latestEase}`;
    }

    static getNewSchedule(settings: EuphoricSettings): RepItemScheduleInfoOsr {
        return RepItemScheduleInfoOsr.fromDueDateStr(
            RepItemScheduleInfoOsr.dummyDueDateForNewCard,
            RepItemScheduleInfoOsr.initialInterval,
            settings.baseEase,
        );
    }

    static fromDueDateStr(
        dueDateStr: string,
        interval: number,
        ease: number,
        delayedBeforeReviewTicks: number | null = null,
    ): RepItemScheduleInfoOsr {
        const dueDate: Moment = DateUtil.dateStrToMoment(dueDateStr);
        return new RepItemScheduleInfoOsr(dueDate, interval, ease, delayedBeforeReviewTicks);
    }
}

// core SM-2-OSR function — arithmetic must not be changed

export function osrSchedule(
    response: ReviewResponse,
    originalInterval: number,
    ease: number,
    delayedBeforeReview: number,
    settings: EuphoricSettings,
    dueDateHistogram?: DueDateHistogram,
): { interval: number; ease: number } {
    const delayedBeforeReviewDays = Math.max(0, Math.floor(delayedBeforeReview / TICKS_PER_DAY));
    let interval: number = Math.max(1, originalInterval);

    if (response === ReviewResponse.Easy) {
        ease += 20;
        interval = ((interval + delayedBeforeReviewDays) * ease) / 100;
        interval *= settings.easyBonus;
    } else if (response === ReviewResponse.Good) {
        interval = ((interval + delayedBeforeReviewDays / 2) * ease) / 100;
    } else if (response === ReviewResponse.Hard) {
        ease = Math.max(130, ease - 20);
        interval = Math.max(
            1,
            (interval + delayedBeforeReviewDays / 4) * settings.lapsesIntervalChange,
        );
    } else if (response === ReviewResponse.Again) {
        ease = Math.max(130, ease - 20);
        interval = 0;
    }

    if (settings.loadBalance && dueDateHistogram !== undefined) {
        interval = Math.round(interval);
        if (interval > 7) {
            let fuzz: number;
            if (interval <= 21) fuzz = 1;
            else if (interval <= 180) fuzz = Math.min(3, Math.floor(interval * 0.05));
            else fuzz = Math.min(7, Math.floor(interval * 0.025));
            interval = dueDateHistogram.findLeastUsedIntervalOverRange(interval, fuzz);
        }
    }

    interval = Math.min(interval, settings.maximumInterval);
    interval = Math.round(interval * 10) / 10;

    return { interval, ease };
}

// interval display helper (used for review button labels)

export function textInterval(interval: number | null | undefined, short = true): string {
    if (interval === null || interval === undefined) return "New";

    const m: number = Math.round(interval / 3.04375) / 10;
    const y: number = Math.round(interval / 36.525) / 10;

    if (short) {
        if (m < 1.0) return `${interval}d`;
        else if (y < 1.0) return `${m}mo`;
        else return `${y}yr`;
    } else {
        if (m < 1.0) return `${interval} day(s)`;
        else if (y < 1.0) return `${m} month(s)`;
        else return `${y} year(s)`;
    }
}

// card level algorithm (note level methods removed — not used in this plugin)

export class SRAlgorithmOsr {
    private settings: EuphoricSettings;

    constructor(settings: EuphoricSettings) {
        this.settings = settings;
    }

    static readonly initialInterval: number = 1.0;

    cardGetResetSchedule(): RepItemScheduleInfoOsr {
        // used after Again → OK: schedule the card 1 day out so it doesn't
        // resurface in today's session or the next fresh session.
        const dueDate = globalDateProvider.today.clone().add(SRAlgorithmOsr.initialInterval, "d");
        return new RepItemScheduleInfoOsr(
            dueDate,
            SRAlgorithmOsr.initialInterval,
            this.settings.baseEase,
            0,
        );
    }

    cardGetNewSchedule(
        response: ReviewResponse,
        dueDateFlashcardHistogram: DueDateHistogram,
    ): RepItemScheduleInfoOsr {
        const schedObj = osrSchedule(
            response,
            SRAlgorithmOsr.initialInterval,
            this.settings.baseEase,
            0,
            this.settings,
            dueDateFlashcardHistogram,
        );
        const dueDate = globalDateProvider.today.clone().add(schedObj.interval, "d");
        return new RepItemScheduleInfoOsr(dueDate, schedObj.interval, schedObj.ease, 0);
    }

    cardCalcUpdatedSchedule(
        response: ReviewResponse,
        cardSchedule: RepItemScheduleInfoOsr,
        dueDateFlashcardHistogram: DueDateHistogram,
    ): RepItemScheduleInfoOsr {
        const schedObj = osrSchedule(
            response,
            cardSchedule.interval,
            cardSchedule.latestEase,
            cardSchedule.delayedBeforeReviewTicks,
            this.settings,
            dueDateFlashcardHistogram,
        );
        const dueDate = globalDateProvider.today.clone().add(schedObj.interval, "d");
        return new RepItemScheduleInfoOsr(dueDate, schedObj.interval, schedObj.ease, 0);
    }
}
