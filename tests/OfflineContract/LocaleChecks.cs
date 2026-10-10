using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Yap.Models;
using Yap.Services;

static class LocaleChecks
{
    public static async Task Run(HttpClient http, string csrf, User user)
    {
        var original = (user.TimeZone, user.Locale, user.DateFormat);
        async Task<HttpResponseMessage> Detect(string zone, string locale, bool token = true)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/chat/preferences/detect")
            {
                Content = JsonContent.Create(new { timeZone = zone, locale, path = "/lobby" })
            };
            if (token)
                request.Headers.Add("X-CSRF-TOKEN", csrf);
            return await http.SendAsync(request);
        }
        void Check(bool condition, string label)
        {
            if (!condition)
                throw new Exception(label);
            Console.WriteLine("PASS " + label);
        }
        try
        {
            user.TimeZone = user.Locale = user.DateFormat = null;
            using var rejected = await Detect("America/New_York", "en-US", false);
            Check(rejected.StatusCode == HttpStatusCode.Forbidden && user.TimeZone == null, "locale detection requires antiforgery");
            using var invalid = await Detect("invalid-zone", "en-US");
            Check(invalid.StatusCode == HttpStatusCode.BadRequest && user.TimeZone == null, "invalid timezone cannot replace missing defaults");
            using var detected = await Detect("America/New_York", "en-US");
            var update = await detected.Content.ReadFromJsonAsync<JsonElement>();
            Check(detected.IsSuccessStatusCode && user.TimeZone == "America/New_York" && user.Locale == "en-US"
                && user.DateFormat == LocaleResolver.GuessDateFormatFromLocale("en-US")
                && update.GetProperty("state").GetProperty("dateSettings").GetProperty("time").GetString() == "h:mm tt",
                "new account detects browser timezone and US twelve-hour format");
            using var repeat = await Detect("Europe/Prague", "cs-CZ");
            Check(repeat.IsSuccessStatusCode && user.TimeZone == "America/New_York" && user.Locale == "en-US", "second device cannot overwrite saved locale");
            user.Locale = null;
            user.DateFormat = "dmy-24h";
            using var partial = await Detect("Europe/Prague", "cs-CZ");
            Check(partial.IsSuccessStatusCode && user.TimeZone == "America/New_York" && user.DateFormat == "dmy-24h" && user.Locale == "cs-CZ",
                "missing locale fills without replacing explicit timezone or clock style");
        }
        finally { (user.TimeZone, user.Locale, user.DateFormat) = original; }
    }
}
