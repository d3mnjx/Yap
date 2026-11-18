using System.Buffers.Binary;
using System.Net;
using System.Text;

namespace Yap.Services.Accounts;

/// <summary>
/// Reads IP2Location LITE DB3 BIN files for IP-to-country/region/city lookup.
/// No NuGet dependency — parses the binary format directly.
/// Drop a DB3 BIN file into Data/ip2location/ to enable.
/// The DB3.IPV6 variant holds both address families; with the IPv4-only file, IPv6 lookups return null.
/// </summary>
public class GeoLocationService
{
    // One address family's table in the BIN file. The two tables have the same layout; only the row key differs:
    // 4 bytes for IPv4, 16 for IPv6. The columns after the key are 4-byte pointers in both.
    private readonly record struct Table(uint Count, uint BaseAddr, uint IndexBaseAddr, int KeySize, int RowSize);

    private readonly byte[]? _data;
    private readonly Table _ipv4, _ipv6;
    private readonly ILogger<GeoLocationService> _logger;

    public bool IsAvailable => _data != null;

    public GeoLocationService(IWebHostEnvironment env, ILogger<GeoLocationService> logger)
    {
        _logger = logger;

        try
        {
            var dir = Path.Combine(env.ContentRootPath, "Data", "ip2location");
            if (!Directory.Exists(dir))
            {
                _logger.LogInformation("IP2Location: directory not found, geolocation disabled");
                return;
            }

            // Find any DB3 BIN file; the IPV6 variant is a superset (both families), so prefer it when both are present
            var binFile = Directory.GetFiles(dir, "*DB3*.BIN")
                .OrderByDescending(f => f.Contains("IPV6", StringComparison.OrdinalIgnoreCase))
                .FirstOrDefault();
            if (binFile == null)
            {
                _logger.LogInformation("IP2Location: no *DB3*.BIN file found, geolocation disabled");
                return;
            }

            var sw = System.Diagnostics.Stopwatch.StartNew();
            _data = File.ReadAllBytes(binFile);
            sw.Stop();

            // Header: byte[0]=dbType, byte[1]=columns, bytes[5..8]=ipv4Count, bytes[9..12]=ipv4Base,
            // bytes[13..16]=ipv6Count, bytes[17..20]=ipv6Base, bytes[21..24]=ipv4IndexBase, bytes[25..28]=ipv6IndexBase
            var pointerBytes = (_data[1] - 1) * 4;   // every column after the row key
            _ipv4 = new Table(Count: ReadUInt32(5), BaseAddr: ReadUInt32(9), IndexBaseAddr: ReadUInt32(21), KeySize: 4, RowSize: 4 + pointerBytes);
            _ipv6 = new Table(Count: ReadUInt32(13), BaseAddr: ReadUInt32(17), IndexBaseAddr: ReadUInt32(25), KeySize: 16, RowSize: 16 + pointerBytes);

            _logger.LogInformation("IP2Location DB{Type} loaded: {V4Count} IPv4 + {V6Count} IPv6 records from {File} ({Size}MB, {Time}ms)",
                _data[0], _ipv4.Count, _ipv6.Count, Path.GetFileName(binFile),
                _data.Length / (1024 * 1024), sw.ElapsedMilliseconds);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to load IP2Location database, geolocation disabled");
            _data = null;
        }
    }

    // The country name for the admin tables, or null when there is none to show. The database marks
    // private and reserved ranges with the country code "-", which is not a name.
    public string? CountryOf(string? ipAddress) =>
        Lookup(ipAddress) is { CountryCode: not "-", Country.Length: > 0 } info ? info.Country : null;

    public GeoInfo? Lookup(string? ipAddress)
    {
        if (_data == null || string.IsNullOrEmpty(ipAddress)) return null;

        try
        {
            if (!IPAddress.TryParse(ipAddress, out var addr))
                return null;

            // Dualstack Kestrel reports IPv4 clients as ::ffff:a.b.c.d — unwrap them to the IPv4 table
            if (addr.IsIPv4MappedToIPv6)
                addr = addr.MapToIPv4();

            var bytes = addr.GetAddressBytes();   // 4 or 16 bytes, big-endian
            return addr.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork
                ? Search(_ipv4, BinaryPrimitives.ReadUInt32BigEndian(bytes))
                : Search(_ipv6, BinaryPrimitives.ReadUInt128BigEndian(bytes));
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "GeoLocation lookup failed for {IP}", ipAddress);
            return null;
        }
    }

    /// <summary>The record whose address range holds <paramref name="ipNum"/>. One search serves both tables: an
    /// IPv4 address is a small number in the same 128-bit type.</summary>
    private GeoInfo? Search(Table table, UInt128 ipNum)
    {
        if (table.Count == 0) return null; // IPv4-only BIN file loaded: it has no IPv6 table

        uint low = 0;
        uint high = table.Count - 1;

        // Use index for faster narrowing (index by first two address bytes, the same layout in both tables)
        if (table.IndexBaseAddr > 0)
        {
            var firstTwoBytes = (uint)(ipNum >> (table.KeySize * 8 - 16));
            var indexPos = (int)(table.IndexBaseAddr - 1 + firstTwoBytes * 8);
            low = ReadUInt32(indexPos);
            high = ReadUInt32(indexPos + 4);
        }

        // Binary search
        while (low <= high)
        {
            var mid = (low + high) / 2;
            var rowOffset = (int)(table.BaseAddr - 1 + mid * (uint)table.RowSize);
            var ipFrom = ReadKey(rowOffset, table.KeySize);
            var ipTo = ReadKey(rowOffset + table.RowSize, table.KeySize); // ip_from of next row

            if (ipNum < ipFrom)
            {
                if (mid == 0) break;
                high = mid - 1;
            }
            else if (ipNum >= ipTo)
            {
                low = mid + 1;
            }
            else
            {
                return ReadRecord(rowOffset + table.KeySize); // pointers follow the key
            }
        }

        return null;
    }

    private GeoInfo ReadRecord(int pointerBase)
    {
        // DB3 pointer columns after the row key: [country_ptr:4][region_ptr:4][city_ptr:4]
        var countryPtr = (int)ReadUInt32(pointerBase);
        var regionPtr = (int)ReadUInt32(pointerBase + 4);
        var cityPtr = (int)ReadUInt32(pointerBase + 8);

        var countryCode = ReadString(countryPtr);
        var countryName = ReadString(countryPtr + 3);
        var region = ReadString(regionPtr);
        var city = ReadString(cityPtr);

        return new GeoInfo
        {
            CountryCode = countryCode,
            Country = countryName,
            Region = region,
            City = city
        };
    }

    private string ReadString(int pos)
    {
        if (pos < 0 || pos >= _data!.Length) return "";
        var length = _data[pos];
        if (pos + 1 + length > _data.Length) return "";
        return Encoding.UTF8.GetString(_data, pos + 1, length);
    }

    private uint ReadUInt32(int offset)
    {
        return BitConverter.ToUInt32(_data!, offset);
    }

    // The BIN file stores every integer little-endian, including the 16-byte IPv6 key —
    // only the wire address bytes (GetAddressBytes) are big-endian. Don't "fix" one to match the other.
    private UInt128 ReadKey(int offset, int keySize) =>
        keySize == 4 ? ReadUInt32(offset) : BinaryPrimitives.ReadUInt128LittleEndian(_data.AsSpan(offset));
}

public class GeoInfo
{
    public string CountryCode { get; init; } = "";
    public string Country { get; init; } = "";
    public string Region { get; init; } = "";
    public string City { get; init; } = "";

    public override string ToString()
    {
        if (CountryCode == "-") return "";
        return Country;
    }
}
