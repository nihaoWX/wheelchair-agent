//! Wall-clock helpers for the recorder fields.

use std::time::{SystemTime, UNIX_EPOCH};

const DAY_MS: f64 = 86_400_000.0;

/// The same value as `Date.now()`.
pub fn now_ms() -> f64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs_f64() * 1000.0,
        Err(error) => -(error.duration().as_secs_f64() * 1000.0),
    }
}

/// The same string as `new Date(ms).toISOString()`: UTC, millisecond precision, trailing `Z`.
pub fn iso(ms: f64) -> String {
    let millis = if ms.is_finite() { ms.trunc() as i64 } else { 0 };
    let days = millis.div_euclid(86_400_000);
    let remainder = millis.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let hour = remainder / 3_600_000;
    let minute = (remainder % 3_600_000) / 60_000;
    let second = (remainder % 60_000) / 1000;
    let millisecond = remainder % 1000;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, minute, second, millisecond
    )
}

/// Days since 1970-01-01 to a Gregorian calendar date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// `keepDays` converted to the same millisecond window the JavaScript used.
pub fn keep_days_ms(days: f64) -> f64 {
    days * DAY_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_instants() {
        assert_eq!(iso(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_700_000_000_123.0), "2023-11-14T22:13:20.123Z");
    }

    #[test]
    fn formats_a_leap_day() {
        assert_eq!(iso(1_709_164_800_000.0), "2024-02-29T00:00:00.000Z");
    }
}
