"""生成问渠下载器扩展图标"""
from PIL import Image, ImageDraw, ImageFont
import os

ICON_DIR = r"C:\Users\杨建茹\.qclaw\workspace\wenqu-dl\extension\icons"
os.makedirs(ICON_DIR, exist_ok=True)

def create_icon(size):
    """创建一个红色🦞风格的图标"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # 背景：圆角矩形，深蓝色
    margin = max(1, size // 16)
    radius = size // 4
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=radius,
        fill=(15, 15, 26, 240),  # 深蓝背景
        outline=(79, 140, 255, 200),  # 蓝色边框
        width=max(1, size // 32)
    )
    
    # 中间画一个下载箭头（白色）
    cx, cy = size // 2, size // 2
    arrow_w = size // 4
    arrow_h = size // 3
    head_h = size // 5
    shaft_h = arrow_h - head_h
    
    # 箭头杆（上方）
    shaft_top = cy - arrow_h // 2
    shaft_bottom = shaft_top + shaft_h
    shaft_left = cx - arrow_w // 4
    shaft_right = cx + arrow_w // 4
    draw.rectangle([shaft_left, shaft_top, shaft_right, shaft_bottom], fill=(79, 140, 255))
    
    # 箭头头（三角形）
    head_top = shaft_bottom - 2
    head_bottom = cy + arrow_h // 2 + size // 8
    head_left = cx - arrow_w // 2 - 2
    head_right = cx + arrow_w // 2 + 2
    draw.polygon([
        (cx, head_bottom),
        (head_left, head_top),
        (head_right, head_top)
    ], fill=(79, 140, 255))
    
    # 底部横线
    line_y = head_bottom + 2
    line_w = arrow_w + size // 8
    line_h = max(2, size // 16)
    draw.rounded_rectangle(
        [cx - line_w // 2, line_y, cx + line_w // 2, line_y + line_h],
        radius=line_h // 2,
        fill=(255, 107, 53)  # 橙色
    )
    
    # 顶部小圆点（🦞眼睛）
    dot_r = max(2, size // 10)
    draw.ellipse([cx - dot_r, shaft_top - dot_r * 2, cx + dot_r, shaft_top], fill=(255, 107, 53))
    
    return img

for s in [16, 32, 48, 128]:
    img = create_icon(s)
    img.save(os.path.join(ICON_DIR, f"icon{s}.png"))
    print(f"OK icon{s}.png")

print("Icons done!")
