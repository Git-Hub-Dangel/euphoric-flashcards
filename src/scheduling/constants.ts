export const PREFERRED_DATE_FORMAT = "YYYY-MM-DD";
export const ALLOWED_DATE_FORMATS = [PREFERRED_DATE_FORMAT, "DD-MM-YYYY", "ddd MMM DD YYYY"];
export const TICKS_PER_DAY = 24 * 3600 * 1000;

export const SR_HTML_COMMENT_BEGIN = "<!--SR:";
export const SR_HTML_COMMENT_END = "-->";
export const DUMMY_DUE_DATE_FOR_NEW_CARD = "2000-01-01";

export const MULTI_SCHEDULING_EXTRACTOR = /!([\d-]+),(\d+),(\d+)/gm;
export const SR_COMMENT_FINDER = /\s?<!--SR:!.+?-->/g;
