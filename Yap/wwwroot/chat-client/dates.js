export function timestamp(value, settings, nowValue = Date.now()) {
    const s = settings || {
        zone: 'UTC',
        time: 'HH:mm',
        dateInYear: 'dd/MM',
        fullDate: 'dd/MM/yyyy',
        dateSeparator: '/',
        timeSeparator: ':',
        amDesignator: 'AM',
        pmDesignator: 'PM',
    };
    function parts(value) {
        const date = new Date(
            typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
        );
        try {
            const p = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
                timeZone: s.zone,
                year: 'numeric',
                month: 'numeric',
                day: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                hourCycle: 'h23',
            }).formatToParts(date);
            return Object.fromEntries(
                p.filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]),
            );
        } catch {
            const d = new Date(date.getTime() + (s.offsetMinutes || 0) * 60000);
            return {
                year: d.getUTCFullYear(),
                month: d.getUTCMonth() + 1,
                day: d.getUTCDate(),
                hour: d.getUTCHours(),
                minute: d.getUTCMinutes(),
            };
        }
    }
    const p = parts(value),
        now = parts(nowValue),
        pad = (n) => String(n).padStart(2, '0');
    const format = (pattern) =>
        pattern.replace(
            /yyyy|MM|dd|HH|mm|tt|M|d|h|\/|:/g,
            (t) =>
                ({
                    yyyy: p.year,
                    MM: pad(p.month),
                    dd: pad(p.day),
                    HH: pad(p.hour),
                    mm: pad(p.minute),
                    tt: p.hour < 12 ? s.amDesignator : s.pmDesignator,
                    M: p.month,
                    d: p.day,
                    h: p.hour % 12 || 12,
                    '/': s.dateSeparator,
                    ':': s.timeSeparator,
                })[t],
        );
    const age = Date.UTC(now.year, now.month - 1, now.day) - Date.UTC(p.year, p.month - 1, p.day),
        time = format(s.time);
    return age === 0
        ? time
        : age === 86400000
          ? 'Yesterday ' + time
          : format(p.year === now.year ? s.dateInYear : s.fullDate) + ' ' + time;
}
