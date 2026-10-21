// Text measurement for column auto-fit. The engine asks for a
// measure(text, style) function so it never touches the DOM itself.
let ctx = null

export function measureText(text, style) {
    if (!ctx) ctx = document.createElement('canvas').getContext('2d')
    ctx.font = `${style.italic ? 'italic ' : ''}${style.bold ? 700 : 400} ${style.fontSize}px system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`
    return ctx.measureText(text).width
}
