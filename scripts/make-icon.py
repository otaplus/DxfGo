"""Genera el icono de la aplicación (PNG 512x512 e ICO multiplataforma)."""

from PIL import Image, ImageDraw

SIZE = 512
SCALE = 4  # Supermuestreo para bordes suaves.
S = SIZE * SCALE

BG_DARK = (27, 27, 30, 255)
BG_LIGHT = (37, 37, 42, 255)
CYAN = (0, 229, 255, 255)
CYAN_SOFT = (0, 216, 255, 140)
GREEN = (0, 255, 102, 255)
ORANGE = (255, 153, 0, 255)
WHITE = (255, 255, 255, 255)


def rounded_rect(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def main():
    image = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # Fondo: cuadrado redondeado con degradado vertical.
    background = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gradient = ImageDraw.Draw(background)
    for y in range(S):
        t = y / S
        color = tuple(
            int(BG_DARK[i] + (BG_LIGHT[i] - BG_DARK[i]) * t) for i in range(3)
        ) + (255,)
        gradient.line([(0, y), (S, y)], fill=color)

    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(0.22 * S), fill=255)
    image.paste(background, (0, 0), mask)

    # Contorno de la pieza (perfil exterior).
    margin = int(0.20 * S)
    rounded_rect(
        draw,
        [margin, margin, S - margin, S - margin],
        radius=int(0.06 * S),
        outline=CYAN,
        width=int(0.028 * S),
    )

    # Agujero interior con su trayectoria compensada.
    cx = cy = S // 2
    hole = int(0.11 * S)
    draw.ellipse(
        [cx - hole - int(0.02 * S), cy - hole - int(0.02 * S),
         cx + hole + int(0.02 * S), cy + hole + int(0.02 * S)],
        outline=CYAN_SOFT,
        width=int(0.012 * S),
    )
    draw.ellipse(
        [cx - hole, cy - hole, cx + hole, cy + hole],
        outline=CYAN,
        width=int(0.022 * S),
    )

    # Pestañas de sujeción sobre el contorno superior.
    tab_width = int(0.10 * S)
    tab_height = int(0.035 * S)
    for fraction in (0.34, 0.66):
        tx = margin + (S - 2 * margin) * fraction
        draw.rectangle(
            [tx - tab_width // 2, margin - tab_height // 2,
             tx + tab_width // 2, margin + tab_height // 2],
            fill=ORANGE,
        )

    # Herramienta (fresa) en la esquina inferior derecha del contorno.
    tool_x = int(S * 0.735)
    tool_y = int(S * 0.735)
    tool_r = int(0.045 * S)
    draw.ellipse(
        [tool_x - tool_r * 2, tool_y - tool_r * 2,
         tool_x + tool_r * 2, tool_y + tool_r * 2],
        outline=(255, 255, 255, 90),
        width=int(0.008 * S),
    )
    draw.ellipse(
        [tool_x - tool_r, tool_y - tool_r, tool_x + tool_r, tool_y + tool_r],
        fill=GREEN,
    )
    draw.ellipse(
        [tool_x - int(tool_r * 0.3), tool_y - int(tool_r * 0.3),
         tool_x + int(tool_r * 0.3), tool_y + int(tool_r * 0.3)],
        fill=WHITE,
    )

    # Ejes X e Y del cero pieza, en la esquina inferior izquierda.
    origin_x = int(S * 0.30)
    origin_y = int(S * 0.72)
    axis = int(0.075 * S)
    draw.line([origin_x, origin_y, origin_x + axis, origin_y], fill=(255, 51, 51, 255),
              width=int(0.012 * S))
    draw.line([origin_x, origin_y, origin_x, origin_y - axis], fill=(51, 255, 51, 255),
              width=int(0.012 * S))
    dot = int(0.012 * S)
    draw.ellipse([origin_x - dot, origin_y - dot, origin_x + dot, origin_y + dot],
                 fill=(255, 255, 0, 255))

    icon = image.resize((SIZE, SIZE), Image.LANCZOS)

    import os
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "build")
    os.makedirs(out_dir, exist_ok=True)
    png_path = os.path.join(out_dir, "icon.png")
    ico_path = os.path.join(out_dir, "icon.ico")
    icon.save(png_path, format="PNG")
    icon.save(ico_path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64),
                               (128, 128), (256, 256)])
    print("OK", png_path, ico_path)


if __name__ == "__main__":
    main()
