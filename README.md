# DXF to G-Code

Aplicación Python para convertir archivos DXF en código G para máquinas CNC.

## Requisitos

- Python 3.8+
- ezdxf

## Instalación

```bash
pip install -r requirements.txt
```

## Uso

```bash
python dxf2gcode.py
```

## Funcionalidades

- Carga archivos DXF
- Vista previa de trayectorias
- Soporte para: LINE, ARC, CIRCLE, LWPOLYLINE, POLYLINE
- Configuración de Z (entrada, trabajo, salida)
- Feed rate personalizable
- Modo taladrado (G81/G82)
- Código G de inicio/fin personalizable
- Exporta a .nc o .gcode
