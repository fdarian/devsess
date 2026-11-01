import SwiftUI

struct ClaudeMark: Shape {
    // Converted from Claude.app's ion-dist/assets/v1/cd02a42d9-Vq_H3mgS.svg (248 × 248).
    private static let outline: Path = {
        var path = Path()
        path.addLines([
            CGPoint(x: 52.4285, y: 162.873), CGPoint(x: 98.7844, y: 136.879),
            CGPoint(x: 99.5485, y: 134.602), CGPoint(x: 98.7844, y: 133.334),
            CGPoint(x: 96.4921, y: 133.334), CGPoint(x: 88.7237, y: 132.862),
            CGPoint(x: 62.2346, y: 132.153), CGPoint(x: 39.3113, y: 131.207),
            CGPoint(x: 17.0249, y: 130.026), CGPoint(x: 11.4214, y: 128.844),
            CGPoint(x: 6.2, y: 121.873), CGPoint(x: 6.7094, y: 118.447),
            CGPoint(x: 11.4214, y: 115.257), CGPoint(x: 18.171, y: 115.847),
            CGPoint(x: 33.0711, y: 116.911), CGPoint(x: 55.485, y: 118.447),
            CGPoint(x: 71.6586, y: 119.392), CGPoint(x: 95.728, y: 121.873),
            CGPoint(x: 99.5485, y: 121.873), CGPoint(x: 100.058, y: 120.337),
            CGPoint(x: 98.7844, y: 119.392), CGPoint(x: 97.7656, y: 118.447),
            CGPoint(x: 74.5877, y: 102.732), CGPoint(x: 49.4995, y: 86.1905),
            CGPoint(x: 36.3823, y: 76.62), CGPoint(x: 29.3779, y: 71.7757),
            CGPoint(x: 25.8121, y: 67.2858), CGPoint(x: 24.2839, y: 57.3608),
            CGPoint(x: 30.6515, y: 50.2716), CGPoint(x: 39.3113, y: 50.8623),
            CGPoint(x: 41.4763, y: 51.4531), CGPoint(x: 50.2636, y: 58.1879),
            CGPoint(x: 68.9842, y: 72.7209), CGPoint(x: 93.4357, y: 90.6804),
            CGPoint(x: 97.0015, y: 93.6343), CGPoint(x: 98.4374, y: 92.6652),
            CGPoint(x: 98.6571, y: 91.9801), CGPoint(x: 97.0015, y: 89.2625),
            CGPoint(x: 83.757, y: 65.2772), CGPoint(x: 69.621, y: 40.8192),
            CGPoint(x: 63.2534, y: 30.6579), CGPoint(x: 61.5978, y: 24.632)
        ])
        path.addCurve(to: CGPoint(x: 60.579, y: 17.4246),
            control1: CGPoint(x: 60.9565, y: 22.1032), control2: CGPoint(x: 60.579, y: 20.0111))
        for point in [
            CGPoint(x: 67.8381, y: 7.49965), CGPoint(x: 71.9133, y: 6.19995),
            CGPoint(x: 81.7193, y: 7.49965), CGPoint(x: 85.7946, y: 11.0443),
            CGPoint(x: 91.9074, y: 24.9865), CGPoint(x: 101.714, y: 46.8451),
            CGPoint(x: 116.996, y: 76.62), CGPoint(x: 121.453, y: 85.4816),
            CGPoint(x: 123.873, y: 93.6343), CGPoint(x: 124.764, y: 96.1155),
            CGPoint(x: 126.292, y: 96.1155), CGPoint(x: 126.292, y: 94.6976),
            CGPoint(x: 127.566, y: 77.9197), CGPoint(x: 129.858, y: 57.3608),
            CGPoint(x: 132.15, y: 30.8942), CGPoint(x: 132.915, y: 23.4505),
            CGPoint(x: 136.608, y: 14.4708), CGPoint(x: 143.994, y: 9.62643),
            CGPoint(x: 149.725, y: 12.344), CGPoint(x: 154.437, y: 19.0788),
            CGPoint(x: 153.8, y: 23.4505), CGPoint(x: 150.998, y: 41.6463),
            CGPoint(x: 145.522, y: 70.1215), CGPoint(x: 141.957, y: 89.2625),
            CGPoint(x: 143.994, y: 89.2625), CGPoint(x: 146.414, y: 86.7813),
            CGPoint(x: 156.093, y: 74.0206), CGPoint(x: 172.266, y: 53.698),
            CGPoint(x: 179.398, y: 45.6635), CGPoint(x: 187.803, y: 36.802),
            CGPoint(x: 193.152, y: 32.5484), CGPoint(x: 203.34, y: 32.5484),
            CGPoint(x: 210.726, y: 43.6549), CGPoint(x: 207.415, y: 55.1159),
            CGPoint(x: 196.972, y: 68.3492), CGPoint(x: 188.312, y: 79.5739),
            CGPoint(x: 175.896, y: 96.2095), CGPoint(x: 168.191, y: 109.585),
            CGPoint(x: 168.882, y: 110.689), CGPoint(x: 170.738, y: 110.53),
            CGPoint(x: 198.755, y: 104.504), CGPoint(x: 213.91, y: 101.787),
            CGPoint(x: 231.994, y: 98.7149), CGPoint(x: 240.144, y: 102.496),
            CGPoint(x: 241.036, y: 106.395), CGPoint(x: 237.852, y: 114.311),
            CGPoint(x: 218.495, y: 119.037), CGPoint(x: 195.826, y: 123.645),
            CGPoint(x: 162.07, y: 131.592), CGPoint(x: 161.696, y: 131.893),
            CGPoint(x: 162.137, y: 132.547), CGPoint(x: 177.36, y: 133.925),
            CGPoint(x: 183.855, y: 134.279), CGPoint(x: 199.774, y: 134.279),
            CGPoint(x: 229.447, y: 136.524), CGPoint(x: 237.215, y: 141.605),
            CGPoint(x: 241.8, y: 147.867), CGPoint(x: 241.036, y: 152.711),
            CGPoint(x: 229.065, y: 158.737), CGPoint(x: 213.019, y: 154.956),
            CGPoint(x: 175.45, y: 145.977), CGPoint(x: 162.587, y: 142.787),
            CGPoint(x: 160.805, y: 142.787), CGPoint(x: 160.805, y: 143.85),
            CGPoint(x: 171.502, y: 154.366), CGPoint(x: 191.242, y: 172.089),
            CGPoint(x: 215.82, y: 195.011), CGPoint(x: 217.094, y: 200.682),
            CGPoint(x: 213.91, y: 205.172), CGPoint(x: 210.599, y: 204.699),
            CGPoint(x: 188.949, y: 188.394), CGPoint(x: 180.544, y: 181.069),
            CGPoint(x: 161.696, y: 165.118), CGPoint(x: 160.422, y: 165.118),
            CGPoint(x: 160.422, y: 166.772), CGPoint(x: 164.752, y: 173.152),
            CGPoint(x: 187.803, y: 207.771), CGPoint(x: 188.949, y: 218.405),
            CGPoint(x: 187.294, y: 221.832), CGPoint(x: 181.308, y: 223.959),
            CGPoint(x: 174.813, y: 222.777), CGPoint(x: 161.187, y: 203.754),
            CGPoint(x: 147.305, y: 182.486), CGPoint(x: 136.098, y: 163.345),
            CGPoint(x: 134.745, y: 164.2), CGPoint(x: 128.075, y: 235.42),
            CGPoint(x: 125.019, y: 239.082), CGPoint(x: 117.887, y: 241.8),
            CGPoint(x: 111.902, y: 237.31), CGPoint(x: 108.718, y: 229.984),
            CGPoint(x: 111.902, y: 215.452), CGPoint(x: 115.722, y: 196.547),
            CGPoint(x: 118.779, y: 181.541), CGPoint(x: 121.58, y: 162.873),
            CGPoint(x: 123.291, y: 156.636), CGPoint(x: 123.14, y: 156.219),
            CGPoint(x: 121.773, y: 156.449), CGPoint(x: 107.699, y: 175.752),
            CGPoint(x: 86.304, y: 204.699), CGPoint(x: 69.3663, y: 222.777),
            CGPoint(x: 65.291, y: 224.431), CGPoint(x: 58.2867, y: 220.768),
            CGPoint(x: 58.9235, y: 214.27), CGPoint(x: 62.8713, y: 208.48),
            CGPoint(x: 86.304, y: 178.705), CGPoint(x: 100.44, y: 160.155),
            CGPoint(x: 109.551, y: 149.507), CGPoint(x: 109.462, y: 147.967),
            CGPoint(x: 108.959, y: 147.924), CGPoint(x: 46.6977, y: 188.512),
            CGPoint(x: 35.6182, y: 189.93), CGPoint(x: 30.7788, y: 185.44),
            CGPoint(x: 31.4156, y: 178.115), CGPoint(x: 33.7079, y: 175.752)
        ] { path.addLine(to: point) }
        path.closeSubpath()
        return path
    }()

    func path(in rect: CGRect) -> Path {
        Self.outline.applying(CGAffineTransform(translationX: rect.minX, y: rect.minY)
            .scaledBy(x: rect.width / 248, y: rect.height / 248))
    }
}
