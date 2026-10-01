import Foundation

enum ServiceRowLabels {
    static func port(for url: URL) -> String {
        guard let host = url.host(percentEncoded: false) else { return url.absoluteString }
        let localhost = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased())
        if localhost, let port = url.port { return ":\(port)" }
        return host
    }

    static func memory(bytes: Double, locale: Locale = Locale(identifier: "en_US_POSIX")) -> String? {
        guard bytes.isFinite, bytes >= 0 else { return nil }
        let gigabyte = 1_073_741_824.0
        if bytes >= gigabyte {
            return (bytes / gigabyte).formatted(.number.locale(locale).precision(.fractionLength(1))) + " GB"
        }
        return (bytes / 1_048_576).formatted(.number.locale(locale).precision(.fractionLength(0))) + " MB"
    }

    static func memory(for service: ServiceRecord, stopping: Bool) -> String? {
        guard !stopping, !service.isFailure,
              service.state != .starting, service.state != .failed,
              service.state != .stopping, let bytes = service.memoryBytes else { return nil }
        return memory(bytes: bytes)
    }
}
