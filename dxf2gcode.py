import tkinter as tk
from tkinter import ttk, filedialog, messagebox, scrolledtext, simpledialog
import sys
import traceback
import math
import ezdxf

class DXFViewer(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("DXF to G-Code - CNC Path Generator")
        self.geometry("1200x800")
        self.configure(bg="#2b2b2b")
        
        self.dxf_doc = None
        self.entities = []
        self.gcode_output = ""
        
        self.setup_ui()
        
    def setup_ui(self):
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TFrame", background="#2b2b2b")
        style.configure("TLabel", background="#2b2b2b", foreground="#ffffff", font=("Segoe UI", 10))
        style.configure("TButton", font=("Segoe UI", 10), padding=6)
        style.configure("TCheckbutton", background="#2b2b2b", foreground="#ffffff")
        style.configure("TEntry", font=("Segoe UI", 10))
        
        main_paned = ttk.PanedWindow(self, orient=tk.HORIZONTAL)
        main_paned.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        
        left_frame = ttk.Frame(main_paned, width=400)
        right_frame = ttk.Frame(main_paned)
        
        main_paned.add(left_frame, weight=1)
        main_paned.add(right_frame, weight=2)
        
        self.create_left_panel(left_frame)
        self.create_right_panel(right_frame)
        
    def create_left_panel(self, parent):
        ttk.Label(parent, text="Archivo DXF", font=("Segoe UI", 11, "bold")).pack(pady=(0, 5))
        
        file_frame = ttk.Frame(parent)
        file_frame.pack(fill=tk.X, pady=5)
        self.file_entry = ttk.Entry(file_frame, textvariable=tk.StringVar())
        self.file_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5))
        ttk.Button(file_frame, text="...", width=3, command=self.browse_file).pack(side=tk.RIGHT)
        
        settings_frame = ttk.LabelFrame(parent, text="Configuración G-Code", padding=10)
        settings_frame.pack(fill=tk.X, pady=10)
        
        ttk.Label(settings_frame, text="Código G de inicio:").pack(anchor=tk.W)
        self.start_gcode = scrolledtext.ScrolledText(settings_frame, height=4, font=("Consolas", 9), bg="#1e1e1e", fg="#00ff00", insertbackground="#00ff00")
        self.start_gcode.pack(pady=5, fill=tk.X)
        self.start_gcode.insert("1.0", "G21 (mm)\nG90 (absoluto)\nG17 (plano XY)\nM3 S1000 (spindle on)")
        
        ttk.Label(settings_frame, text="Código G de fin:").pack(anchor=tk.W)
        self.end_gcode = scrolledtext.ScrolledText(settings_frame, height=3, font=("Consolas", 9), bg="#1e1e1e", fg="#00ff00", insertbackground="#00ff00")
        self.end_gcode.pack(pady=5, fill=tk.X)
        self.end_gcode.insert("1.0", "M5 (spindle off)\nG0 X0 Y0 (home)\nM30 (fin programa)")
        
        post_g0_frame = ttk.Frame(settings_frame)
        post_g0_frame.pack(fill=tk.X, pady=5)
        ttk.Label(post_g0_frame, text="Código extra tras G0:").pack(anchor=tk.W)
        self.post_g0_code = tk.StringVar()
        ttk.Entry(post_g0_frame, textvariable=self.post_g0_code).pack(pady=2, fill=tk.X)
        
        param_frame = ttk.Frame(settings_frame)
        param_frame.pack(fill=tk.X, pady=5)
        
        ttk.Label(param_frame, text="Feed Rate:").grid(row=0, column=0, sticky=tk.W, padx=5, pady=2)
        self.feed_rate = tk.IntVar(value=500)
        ttk.Entry(param_frame, textvariable=self.feed_rate, width=10).grid(row=0, column=1, padx=5, pady=2)
        
        ttk.Label(param_frame, text="Cero Pieza:").grid(row=1, column=0, sticky=tk.W, padx=5, pady=2)
        self.work_zero = tk.StringVar(value="bottom_left")
        ttk.Combobox(param_frame, textvariable=self.work_zero, values=["bottom_left", "center", "drawing_zero"], width=12).grid(row=1, column=1, padx=5, pady=2)
        
        btn_frame = ttk.Frame(parent)
        btn_frame.pack(pady=10, fill=tk.X)
        ttk.Button(btn_frame, text="Cargar DXF", command=self.load_dxf).pack(fill=tk.X, pady=2)
        ttk.Button(btn_frame, text="Generar G-Code", command=self.generate_gcode).pack(fill=tk.X, pady=2)
        ttk.Button(btn_frame, text="Guardar G-Code", command=self.save_gcode).pack(fill=tk.X, pady=2)
        
        ttk.Label(parent, text="Entidades encontradas", font=("Segoe UI", 11, "bold")).pack(pady=(10, 5))
        
        self.entity_listbox = tk.Listbox(parent, bg="#1e1e1e", fg="#00ff00", font=("Consolas", 9), height=10)
        self.entity_listbox.pack(fill=tk.BOTH, expand=True)
        
    def create_right_panel(self, parent):
        notebook = ttk.Notebook(parent)
        notebook.pack(fill=tk.BOTH, expand=True)
        
        preview_frame = ttk.Frame(notebook)
        code_frame = ttk.Frame(notebook)
        
        notebook.add(preview_frame, text="Vista Previa")
        notebook.add(code_frame, text="G-Code")
        
        self.canvas = tk.Canvas(preview_frame, bg="#1e1e1e", width=800, height=600)
        self.canvas.pack(fill=tk.BOTH, expand=True)
        
        self.gcode_text = scrolledtext.ScrolledText(code_frame, font=("Consolas", 9), bg="#1e1e1e", fg="#00ff00", wrap=tk.NONE)
        self.gcode_text.pack(fill=tk.BOTH, expand=True)
        
    def on_canvas_resize(self, event):
        if self.entities:
            self.draw_preview()
            
    def show_error(self, title, message, exception=None):
        error_window = tk.Toplevel(self)
        error_window.title(title)
        error_window.geometry("600x400")
        error_window.configure(bg="#2b2b2b")
        error_window.transient(self)
        error_window.grab_set()
        
        ttk.Label(error_window, text=message, font=("Segoe UI", 10), wraplength=550).pack(pady=10)
        
        error_text = scrolledtext.ScrolledText(error_window, height=8, font=("Consolas", 9), bg="#1e1e1e", fg="#ff5555", wrap=tk.WORD)
        error_text.pack(pady=5, padx=10, fill=tk.BOTH, expand=True)
        
        full_error = message
        if exception:
            full_error += "\n\n" + str(exception)
            if exception.__traceback__:
                tb_lines = traceback.format_exception(type(exception), exception, exception.__traceback__)
                full_error += "\n" + "".join(tb_lines)
        error_text.insert("1.0", full_error)
        error_text.config(state=tk.DISABLED)
        
        button_frame = ttk.Frame(error_window)
        button_frame.pack(pady=5)
        
        ttk.Button(button_frame, text="Copiar al Portapapeles", command=lambda: self.copy_to_clipboard(error_text)).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="Cerrar", command=error_window.destroy).pack(side=tk.LEFT, padx=5)
        
        self.wait_window(error_window)
        
    def copy_to_clipboard(self, text_widget):
        content = text_widget.get("1.0", tk.END).strip()
        self.clipboard_clear()
        self.clipboard_append(content)
        messagebox.showinfo("Copiado", "Error copiado al portapapeles", parent=self)
        
    def browse_file(self):
        filename = filedialog.askopenfilename(
            title="Seleccionar archivo DXF",
            filetypes=[("DXF files", "*.dxf"), ("All files", "*.*")]
        )
        if filename:
            self.file_entry.delete(0, tk.END)
            self.file_entry.insert(0, filename)
            
    def load_dxf(self):
        filename = self.file_entry.get()
        if not filename:
            messagebox.showerror("Error", "Seleccione un archivo DXF")
            return
            
        try:
            self.dxf_doc = ezdxf.readfile(filename)
            self.entities = self.parse_entities()
            self.update_entity_list()
            self.draw_preview()
            messagebox.showinfo("Éxito", f"Se cargaron {len(self.entities)} entidades")
        except Exception as e:
            self.show_error("Error al cargar DXF", f"No se pudo cargar el archivo:\n{str(e)}", e)
            
    def parse_entities(self):
        entities = []
        for entity in self.dxf_doc.modelspace():
            etype = entity.dxftype()
            if etype == "LINE":
                entities.append({"type": "LINE", "data": entity})
            elif etype == "ARC":
                entities.append({"type": "ARC", "data": entity})
            elif etype == "CIRCLE":
                entities.append({"type": "CIRCLE", "data": entity})
            elif etype == "LWPOLYLINE":
                entities.append({"type": "LWPOLYLINE", "data": entity})
            elif etype == "POLYLINE":
                entities.append({"type": "POLYLINE", "data": entity})
        return entities
    
    def update_entity_list(self):
        self.entity_listbox.delete(0, tk.END)
        for i, ent in enumerate(self.entities):
            self.entity_listbox.insert(tk.END, f"{i+1}. {ent['type']}")
            
    def get_zero_offset(self, bounds):
        zero_type = self.work_zero.get()
        min_x, max_x = bounds["min_x"], bounds["max_x"]
        min_y, max_y = bounds["min_y"], bounds["max_y"]
        
        if zero_type == "center":
            return (min_x + max_x) / 2, (min_y + max_y) / 2
        elif zero_type == "bottom_left":
            return min_x, min_y
        else:  # drawing_zero
            return 0, 0
    
    def draw_preview(self):
        self.canvas.delete("all")
        if not self.entities:
            return
            
        bounds = self.get_bounds()
        if not bounds:
            return
        
        canvas_w = self.canvas.winfo_width()
        canvas_h = self.canvas.winfo_height()
        
        scale_x = (canvas_w - 40) / (bounds["max_x"] - bounds["min_x"]) if bounds["max_x"] != bounds["min_x"] else 1
        scale_y = (canvas_h - 40) / (bounds["max_y"] - bounds["min_y"]) if bounds["max_y"] != bounds["min_y"] else 1
        scale = min(scale_x, scale_y) * 0.9
        
        center_x = (bounds["min_x"] + bounds["max_x"]) / 2
        center_y = (bounds["min_y"] + bounds["max_y"]) / 2
        
        offset_x = canvas_w / 2 - center_x * scale
        offset_y = canvas_h / 2 + center_y * scale
        
        zero_x, zero_y = self.get_zero_offset(bounds)
        
        for ent in self.entities:
            self.draw_entity_preview(ent, scale, offset_x, offset_y)
        
        if self.entities:
            self.draw_grid(bounds, scale, offset_x, offset_y, center_x, center_y, zero_x, zero_y)
        
    def get_bounds(self):
        if not self.entities:
            return None
        min_x = min_y = float('inf')
        max_x = max_y = float('-inf')
        for ent in self.entities:
            if ent["type"] == "LINE":
                pts = [ent["data"].dxf.start, ent["data"].dxf.end]
                for p in pts:
                    min_x, max_x = min(min_x, p.x), max(max_x, p.x)
                    min_y, max_y = min(min_y, p.y), max(max_y, p.y)
            elif ent["type"] == "ARC":
                arc = ent["data"]
                min_x = min(min_x, arc.dxf.center.x - arc.dxf.radius)
                max_x = max(max_x, arc.dxf.center.x + arc.dxf.radius)
                min_y = min(min_y, arc.dxf.center.y - arc.dxf.radius)
                max_y = max(max_y, arc.dxf.center.y + arc.dxf.radius)
            elif ent["type"] == "CIRCLE":
                circ = ent["data"]
                min_x = min(min_x, circ.dxf.center.x - circ.dxf.radius)
                max_x = max(max_x, circ.dxf.center.x + circ.dxf.radius)
                min_y = min(min_y, circ.dxf.center.y - circ.dxf.radius)
                max_y = max(max_y, circ.dxf.center.y + circ.dxf.radius)
            elif ent["type"] in ("LWPOLYLINE", "POLYLINE"):
                for p in ent["data"].points():
                    min_x, max_x = min(min_x, p[0]), max(max_x, p[0])
                    min_y, max_y = min(min_y, p[1]), max(max_y, p[1])
        return {"min_x": min_x, "max_x": max_x, "min_y": min_y, "max_y": max_y}
    
    def draw_grid(self, bounds, scale, ox, oy, center_x, center_y, zero_x, zero_y):
        grid_step = 50
        
        min_x = int((bounds["min_x"] - zero_x) // grid_step) * grid_step - grid_step
        max_x = int((bounds["max_x"] - zero_x) // grid_step) * grid_step + grid_step
        min_y = int((bounds["min_y"] - zero_y) // grid_step) * grid_step - grid_step
        max_y = int((bounds["max_y"] - zero_y) // grid_step) * grid_step + grid_step
        
        for x in range(min_x, max_x + 1, grid_step):
            screen_x = x * scale + ox
            if screen_x >= 0 and screen_x <= self.canvas.winfo_width():
                self.canvas.create_line(screen_x, 0, screen_x, self.canvas.winfo_height(), fill="#333333", width=1)
                self.canvas.create_text(screen_x, self.canvas.winfo_height() - 10, text=f"{x+zero_x}", fill="#aaaaaa", font=("Arial", 8))
        
        for y in range(min_y, max_y + 1, grid_step):
            screen_y = -y * scale + oy
            if screen_y >= 0 and screen_y <= self.canvas.winfo_height():
                self.canvas.create_line(0, screen_y, self.canvas.winfo_width(), screen_y, fill="#333333", width=1)
                self.canvas.create_text(10, screen_y, text=f"{y+zero_y}", fill="#aaaaaa", font=("Arial", 8), anchor=tk.W)
        
        zero_screen_x = zero_x * scale + ox
        zero_screen_y = -zero_y * scale + oy
        
        self.canvas.create_oval(zero_screen_x-5, zero_screen_y-5, zero_screen_x+5, zero_screen_y+5, fill="#ffffff", outline="#00ff00", width=2)
        self.canvas.create_text(zero_screen_x, zero_screen_y - 15, text="0,0", fill="#00ff00", font=("Arial", 10))
    
    def draw_entity_preview(self, ent, scale, ox, oy):
        color_map = {"LINE": "#00ff00", "ARC": "#00ffff", "CIRCLE": "#ffff00", "LWPOLYLINE": "#ff00ff", "POLYLINE": "#ff00ff"}
        color = color_map.get(ent["type"], "#ffffff")
        
        if ent["type"] == "LINE":
            p1, p2 = ent["data"].dxf.start, ent["data"].dxf.end
            self.canvas.create_line(p1.x*scale+ox, -p1.y*scale+oy, p2.x*scale+ox, -p2.y*scale+oy, fill=color, width=2)
            
        elif ent["type"] == "ARC":
            arc = ent["data"]
            cx, cy = arc.dxf.center.x, arc.dxf.center.y
            r = arc.dxf.radius
            start_angle = arc.dxf.start_angle
            end_angle = arc.dxf.end_angle
            if arc.dxf.is_counter_clockwise:
                start_angle, end_angle = end_angle, start_angle
            x1, y1 = cx + r*math.cos(math.radians(start_angle)), cy + r*math.sin(math.radians(start_angle))
            x2, y2 = cx + r*math.cos(math.radians(end_angle)), cy + r*math.sin(math.radians(end_angle))
            self.canvas.create_arc((cx-r)*scale+ox, (-cy-r)*scale+oy, (cx+r)*scale+ox, (-cy+r)*scale+oy, start=start_angle, extent=end_angle-start_angle, style=tk.ARC, outline=color)
            
        elif ent["type"] == "CIRCLE":
            circ = ent["data"]
            cx, cy = circ.dxf.center.x, circ.dxf.center.y
            r = circ.dxf.radius
            self.canvas.create_oval((cx-r)*scale+ox, (-cy-r)*scale+oy, (cx+r)*scale+ox, (-cy+r)*scale+oy, outline=color)
            
        elif ent["type"] in ("LWPOLYLINE", "POLYLINE"):
            points = ent["data"].points()
            if len(points) > 1:
                coords = []
                for p in points:
                    coords.extend([p[0]*scale+ox, -p[1]*scale+oy])
                self.canvas.create_line(coords, fill=color, width=2, smooth=True)
                
    def generate_gcode(self):
        if not self.entities:
            messagebox.showerror("Error", "Cargue primero un archivo DXF")
            return
            
        bounds = self.get_bounds()
        if not bounds:
            return
            
        zero_x, zero_y = self.get_zero_offset(bounds)
        
        lines = []
        lines.append("; G-Code generado por DXF to G-Code")
        lines.append("; Cero Pieza: " + self.work_zero.get())
        lines.append("; Fecha: " + __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        lines.extend(self.start_gcode.get("1.0", tk.END).strip().split("\n"))
        
        feed = self.feed_rate.get()
        last_x, last_y = None, None
        first_move = True
        
        for ent in self.entities:
            gcode_lines, last_x, last_y, first_move = self.generate_entity_gcode(ent, feed, last_x, last_y, first_move, zero_x, zero_y)
            lines.extend(gcode_lines)
            
        lines.extend(self.end_gcode.get("1.0", tk.END).strip().split("\n"))
        lines = [line for line in lines if line.strip()]
        
        self.gcode_output = "\n".join(lines)
        self.gcode_text.delete("1.0", tk.END)
        self.gcode_text.insert("1.0", self.gcode_output)
        
        messagebox.showinfo("Éxito", "G-Code generado correctamente")
        
    def generate_entity_gcode(self, ent, feed, last_x, last_y, first_move, zero_x, zero_y):
        gcode = []
        current_x, current_y = None, None
        
        if ent["type"] == "LINE":
            p1, p2 = ent["data"].dxf.start, ent["data"].dxf.end
            x1, y1 = p1.x - zero_x, p1.y - zero_y
            x2, y2 = p2.x - zero_x, p2.y - zero_y
            if last_x is not None and abs(x1 - last_x) < 0.001 and abs(y1 - last_y) < 0.001:
                gcode.append(f"G1 X{x2:.3f} Y{y2:.3f} F{feed}")
                current_x, current_y = x2, y2
            else:
                gcode.append(f"G0 X{x1:.3f} Y{y1:.3f}")
                gcode.append(self.post_g0_code.get())
                gcode.append(f"G1 X{x2:.3f} Y{y2:.3f} F{feed}")
                current_x, current_y = x2, y2
                
        elif ent["type"] == "ARC":
            arc = ent["data"]
            cx, cy = arc.dxf.center.x - zero_x, arc.dxf.center.y - zero_y
            r = arc.dxf.radius
            start_angle = math.radians(arc.dxf.start_angle)
            end_angle = math.radians(arc.dxf.end_angle)
            
            x1 = cx + r * math.cos(start_angle)
            y1 = cy + r * math.sin(start_angle)
            x2 = cx + r * math.cos(end_angle)
            y2 = cy + r * math.sin(end_angle)
            
            if last_x is not None and abs(x1 - last_x) < 0.001 and abs(y1 - last_y) < 0.001:
                is_ccw = arc.dxf.is_counter_clockwise
                g_code = "G2" if not is_ccw else "G3"
                if abs((end_angle - start_angle) % (2*math.pi)) < 0.01:
                    x2, y2 = x1, y1
                gcode.append(f"{g_code} X{x2:.3f} Y{y2:.3f} I{(cx-x1):.3f} J{(cy-y1):.3f} F{feed}")
                current_x, current_y = x2, y2
            else:
                gcode.append(f"G0 X{x1:.3f} Y{y1:.3f}")
                gcode.append(self.post_g0_code.get())
                is_ccw = arc.dxf.is_counter_clockwise
                g_code = "G2" if not is_ccw else "G3"
                if abs((end_angle - start_angle) % (2*math.pi)) < 0.01:
                    x2, y2 = x1, y1
                gcode.append(f"{g_code} X{x2:.3f} Y{y2:.3f} I{(cx-x1):.3f} J{(cy-y1):.3f} F{feed}")
                current_x, current_y = x2, y2
                
        elif ent["type"] == "CIRCLE":
            circ = ent["data"]
            cx, cy = circ.dxf.center.x - zero_x, circ.dxf.center.y - zero_y
            r = circ.dxf.radius
            x1, y1 = cx + r, cy
            if last_x is not None and abs(x1 - last_x) < 0.001 and abs(y1 - last_y) < 0.001:
                gcode.append(f"G2 X{x1:.3f} Y{y1:.3f} I{-r:.3f} J{0:.3f} F{feed}")
                current_x, current_y = x1, y1
            else:
                gcode.append(f"G0 X{x1:.3f} Y{y1:.3f}")
                gcode.append(self.post_g0_code.get())
                gcode.append(f"G2 X{x1:.3f} Y{y1:.3f} I{-r:.3f} J{0:.3f} F{feed}")
                current_x, current_y = x1, y1
                
        elif ent["type"] in ("LWPOLYLINE", "POLYLINE"):
            points = list(ent["data"].points())
            if len(points) < 2:
                return gcode, last_x, last_y, first_move
                
            p1 = points[0]
            x1, y1 = p1[0] - zero_x, p1[1] - zero_y
            if last_x is not None and abs(x1 - last_x) < 0.001 and abs(y1 - last_y) < 0.001:
                pass
            else:
                gcode.append(f"G0 X{x1:.3f} Y{y1:.3f}")
                gcode.append(self.post_g0_code.get())
            
            for i, p in enumerate(points[1:], 1):
                x, y = p[0] - zero_x, p[1] - zero_y
                gcode.append(f"G1 X{x:.3f} Y{y:.3f} F{feed}")
                current_x, current_y = x, y
                
            if ent["data"].is_closed and current_x is not None:
                gcode.append(f"G1 X{x1:.3f} Y{y1:.3f} F{feed}")
                current_x, current_y = x1, y1
        
        if len(gcode) == 0:
            return [], last_x, last_y, first_move
        return gcode, current_x, current_y, False
        
    def save_gcode(self):
        if not self.gcode_output:
            messagebox.showerror("Error", "Genere el G-Code primero")
            return
            
        filename = filedialog.asksaveasfilename(
            title="Guardar G-Code",
            defaultextension=".nc",
            filetypes=[("NC files", "*.nc"), ("G-code files", "*.gcode"), ("All files", "*.*")]
        )
        
        if filename:
            try:
                with open(filename, "w") as f:
                    f.write(self.gcode_output)
                messagebox.showinfo("Éxito", f"G-Code guardado en:\n{filename}")
            except Exception as e:
                self.show_error("Error al guardar", f"No se pudo guardar el archivo:", e)

if __name__ == "__main__":
    app = DXFViewer()
    app.mainloop()
