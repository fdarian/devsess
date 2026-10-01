import Foundation
import Testing
@testable import DevsessBar

struct ServiceRowLabelsTests {
    @Test func localhostPortsAndOtherHosts() throws {
        for host in ["localhost", "LOCALHOST", "127.0.0.1", "[::1]"] {
            #expect(ServiceRowLabels.port(for: try #require(URL(string: "http://\(host):58356/path"))) == ":58356")
        }
        #expect(ServiceRowLabels.port(for: try #require(URL(string: "https://example.com:8443/path"))) == "example.com")
        #expect(ServiceRowLabels.port(for: try #require(URL(string: "http://localhost/path"))) == "localhost")
        #expect(ServiceRowLabels.port(for: try #require(URL(string: "https://example.com"))) == "example.com")
    }

    @Test func memoryUsesBinaryUnitsAndFixedPrecision() {
        let locale = Locale(identifier: "en_US")
        #expect(ServiceRowLabels.memory(bytes: 1.2 * 1_073_741_824, locale: locale) == "1.2 GB")
        #expect(ServiceRowLabels.memory(bytes: 1_073_741_824, locale: locale) == "1.0 GB")
        #expect(ServiceRowLabels.memory(bytes: 340 * 1_048_576, locale: locale) == "340 MB")
        #expect(ServiceRowLabels.memory(bytes: 86 * 1_048_576, locale: locale) == "86 MB")
        #expect(ServiceRowLabels.memory(bytes: 214.4 * 1_048_576, locale: locale) == "214 MB")
        #expect(ServiceRowLabels.memory(bytes: 0, locale: locale) == "0 MB")
        #expect(ServiceRowLabels.memory(bytes: -1, locale: locale) == nil)
        #expect(ServiceRowLabels.memory(bytes: .infinity, locale: locale) == nil)
    }

    @Test func decodesOptionalMemoryWithoutLosingTheService() throws {
        func decode(_ field: String) throws -> ServiceRecord {
            try JSONDecoder().decode(ServiceRecord.self, from: Data("""
            {"name":"web","command":"bun dev","cwd":"/repo","state":"running"\(field)}
            """.utf8))
        }
        #expect(try decode(",\"memoryBytes\":356515840").memoryBytes == 356515840)
        #expect(try decode(",\"memoryBytes\":356515840.25").memoryBytes == 356515840.25)
        #expect(try decode("").memoryBytes == nil)
        #expect(try decode(",\"memoryBytes\":null").memoryBytes == nil)
        #expect(try decode(",\"memoryBytes\":\"invalid\"").memoryBytes == nil)
    }

    @Test func statusTextAndAbsentTelemetryHideMemory() {
        #expect(ServiceRowLabels.memory(for: Fixtures.busy[0].services[0], stopping: false) == "1.2 GB")
        #expect(ServiceRowLabels.memory(for: Fixtures.busy[1].services[0], stopping: false) == nil)
        #expect(ServiceRowLabels.memory(for: Fixtures.busy[2].services[1], stopping: false) == nil)
        #expect(ServiceRowLabels.memory(for: Fixtures.busy[2].services[0], stopping: true) == nil)
        let absent = ServiceRecord(name: "web", command: "bun dev", cwd: "/repo", state: .running,
            exitCode: nil, signal: nil, published: nil)
        #expect(ServiceRowLabels.memory(for: absent, stopping: false) == nil)
    }

    @Test func headerStopGeometryAndPluralization() {
        #expect(RunHeaderGeometry.stopTitle(serviceCount: 1) == "Stop 1 server")
        #expect(RunHeaderGeometry.stopTitle(serviceCount: 2) == "Stop 2 servers")
        #expect(RunHeaderGeometry.shouldArm(at: CGPoint(x: 275, y: 10), width: 290, stopping: false, snapshotMode: false))
        #expect(!RunHeaderGeometry.shouldArm(at: CGPoint(x: 250, y: 10), width: 290, stopping: false, snapshotMode: false))
        #expect(!RunHeaderGeometry.shouldArm(at: CGPoint(x: 275, y: 20), width: 290, stopping: false, snapshotMode: false))
        #expect(!RunHeaderGeometry.shouldArm(at: CGPoint(x: 275, y: 10), width: 290, stopping: true, snapshotMode: false))
        #expect(!RunHeaderGeometry.shouldArm(at: CGPoint(x: 275, y: 10), width: 290, stopping: false, snapshotMode: true))
    }
}
