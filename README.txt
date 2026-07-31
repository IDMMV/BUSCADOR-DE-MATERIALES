BUSCADOR DE MATERIALES SAP V27

Correcciones principales:
- Estado del stock muestra archivo, fecha y hora de carga.
- Alias y matrículas abre su módulo correcto.
- Barra lateral se oculta sin ocultar el contenido y puede mostrarse con ☰.
- Aviso de stock disponible en el centro alternativo 1003/1004.
- Enlace directo a Google Drive dentro de la configuración de Drive.
- Caché PWA actualizada a V27.

PUBLICACIÓN EN GITHUB
1. Reemplazar todos los archivos de la versión anterior.
2. Confirmar los cambios en la rama main.
3. En PC usar Ctrl+F5.
4. En celular cerrar por completo la PWA y volver a abrirla. Si aún aparece una versión anterior, desinstalar y volver a instalar.

V30: al agregar un material, el buscador permanece abierto para continuar agregando.

NOVEDADES V30
- Los datos del pedido aparecen al inicio de Buscar materiales.
- Un material agregado desaparece de los resultados para evitar duplicados.
- En Pedido seleccionado puedes activar Usar 1003 y/o Usar 1004 por cada material.
- Se añadió Exportar control pedido, con las columnas Reserva, Almacén, Encargado, OM, Fecha, Unidad, Conductor, ALIM, Distrito y Status.
- Incluye PLANTILLA_CONTROL_PEDIDOS.xlsx como referencia editable.

V35:
- Campo OM en los datos del pedido.
- Se retiraron los micrófonos de las cantidades.
- Al finalizar, descuenta el stock de cada centro/almacén/lote.
- Genera historial separado por centro.
- Unidad móvil siempre se exporta en UNIDAD (RECOJO).
- Actualiza Code.gs para crear la pestaña Historial en Google Sheets.


NOVEDADES V35:
- Base fija de 412 emplazamientos/circuitos incorporada desde circuitos y alimentadores.xlsx.
- Al seleccionar un emplazamiento (ej. M-A-15), ALIM se completa como A-15 y el distrito se completa automáticamente.
- Si un emplazamiento abarca varios distritos, la web permite elegir el distrito correcto.
- Los botones Usar 1003 y Usar 1004 aparecen junto a Quitar cuando falta stock; se puede usar uno o ambos centros.
- El control Excel e historial guardan Emplazamiento, ALIM y Distrito.
