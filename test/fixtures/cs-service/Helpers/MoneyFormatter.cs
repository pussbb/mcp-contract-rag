namespace Fixture.Helpers;

/// <summary>Formats amounts as currency strings. See <see cref="System.Globalization.CultureInfo"/>.</summary>
public static class MoneyFormatter
{
    public static string Format(decimal value, string locale = "en") => value.ToString();

    private static string Hidden() => "";
}
