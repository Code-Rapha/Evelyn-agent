/**
 * Gera um `.ico` de verdade a partir do PNG de origem.
 *
 * ## Por que este script existe
 *
 * O arquivo entregue como `.ico` era, na verdade, um PNG renomeado (a
 * assinatura `\x89PNG` está lá). A `BrowserWindow` aceita PNG em `icon:`,
 * então a janela pareceria certa — mas o **executável** não: o packager grava
 * os recursos do `.exe` a partir de um ícone real, e o Windows não desenha um
 * PNG com extensão trocada.
 *
 * Um `.ico` é um contêiner: cabeçalho de 6 bytes, uma entrada de 16 bytes por
 * imagem e as imagens. Cada uma pode ser um DIB clássico ou um PNG — o PNG
 * (aceito desde o Vista) é o certo para este caso, porque os tamanhos grandes
 * saem menores e o Windows o lê nativamente.
 *
 * ## Como roda
 *
 * `node make-icon.js`, sem Electron e sem dependência nova: o
 * redimensionamento usa o GDI+ do Windows via `System.Drawing` do PowerShell,
 * e a montagem do contêiner é Node puro.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { join } = require('node:path');

const root = __dirname;
const SOURCE = join(root, 'icons', 'evelyn_icone_lavanda_transparente.png');
const TARGET = join(root, 'icons', 'evelyn_app_icon.ico');
const WORK = join(root, 'dist', 'icon-work');

/** Os tamanhos que o Windows usa: barra de tarefas, explorer, alt-tab, jumbo. */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Redimensiona o PNG para cada tamanho, em PNG de 32 bits com alfa. */
function resizeAll() {
	fs.mkdirSync(WORK, { recursive: true });
	// O desenho não preenche a moldura: há margem transparente em volta, e
	// desigual (mais embaixo do que em cima). Reduzir a moldura inteira deixa
	// a figura minúscula na barra de tarefas. O primeiro passo é **recortar a
	// caixa do conteúdo** e reenquadrá-la num quadrado com 6% de respiro —
	// é o que faz o ícone ocupar o espaço que o Windows lhe dá.
	const script = [
		'Add-Type -AssemblyName System.Drawing',
		`$src = [System.Drawing.Bitmap]::FromFile('${SOURCE.replace(/'/g, "''")}')`,
		// Caixa do conteúdo: amostra a cada 2px, ignorando alfa quase zero.
		'$minX = $src.Width; $minY = $src.Height; $maxX = 0; $maxY = 0',
		'for ($y = 0; $y -lt $src.Height; $y += 2) {',
		'  for ($x = 0; $x -lt $src.Width; $x += 2) {',
		'    if ($src.GetPixel($x, $y).A -gt 8) {',
		'      if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }',
		'      if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }',
		'    }',
		'  }',
		'}',
		'$w = $maxX - $minX; $h = $maxY - $minY',
		'if ($w -le 0 -or $h -le 0) { throw "o PNG não tem conteúdo opaco" }',
		// Quadrado que contém o conteúdo, centrado nele.
		'$side = [Math]::Max($w, $h)',
		'$cx = $minX + $w / 2; $cy = $minY + $h / 2',
		'$left = $cx - $side / 2; $top = $cy - $side / 2',
		...SIZES.map((size) => {
			const out = join(WORK, `${size}.png`).replace(/'/g, "''");
			// 95% do lado: a figura quase toca a borda. O padrão do Windows é
			// ~88%, mas este ícone é um recorte de personagem com muito detalhe
			// fino — no tamanho da barra de tarefas ele lê melhor assim.
			const inner = Math.round(size * 0.95);
			const inset = (size - inner) / 2;
			return [
				`$bmp = New-Object System.Drawing.Bitmap ${size}, ${size}`,
				'$g = [System.Drawing.Graphics]::FromImage($bmp)',
				'$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
				'$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality',
				'$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality',
				'$g.Clear([System.Drawing.Color]::Transparent)',
				`$dst = New-Object System.Drawing.RectangleF ${inset}, ${inset}, ${inner}, ${inner}`,
				`$ref = New-Object System.Drawing.RectangleF $left, $top, $side, $side`,
				'$g.DrawImage($src, $dst, $ref, [System.Drawing.GraphicsUnit]::Pixel)',
				'$g.Dispose()',
				`$bmp.Save('${out}', [System.Drawing.Imaging.ImageFormat]::Png)`,
				'$bmp.Dispose()',
			].join('; ');
		}),
		'$src.Dispose()',
	].join('\n');
	execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'inherit' });
}

/** Monta o contêiner `.ico` a partir dos PNGs. */
function pack() {
	const images = SIZES.map((size) => ({ size, png: fs.readFileSync(join(WORK, `${size}.png`)) }));

	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0); // reservado
	header.writeUInt16LE(1, 2); // tipo: ícone
	header.writeUInt16LE(images.length, 4);

	const directory = Buffer.alloc(16 * images.length);
	let offset = 6 + directory.length;
	images.forEach((image, index) => {
		const at = index * 16;
		// 256 é gravado como 0: é o que o formato define para esse tamanho.
		directory.writeUInt8(image.size >= 256 ? 0 : image.size, at);
		directory.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1);
		directory.writeUInt8(0, at + 2); // paleta
		directory.writeUInt8(0, at + 3); // reservado
		directory.writeUInt16LE(1, at + 4); // planos
		directory.writeUInt16LE(32, at + 6); // bits por pixel
		directory.writeUInt32LE(image.png.length, at + 8);
		directory.writeUInt32LE(offset, at + 12);
		offset += image.png.length;
	});

	fs.writeFileSync(TARGET, Buffer.concat([header, directory, ...images.map((image) => image.png)]));
}

/** Confere o resultado lendo o próprio contêiner de volta. */
function verify() {
	const bytes = fs.readFileSync(TARGET);
	if (bytes.readUInt32BE(0) === 0x89504e47) {
		throw new Error('o destino ainda é um PNG: o contêiner não foi gravado');
	}
	if (bytes.readUInt16LE(2) !== 1) {
		throw new Error('o destino não se declara ícone');
	}
	const count = bytes.readUInt16LE(4);
	const sizes = [];
	for (let index = 0; index < count; index += 1) {
		const at = 6 + index * 16;
		const width = bytes.readUInt8(at) === 0 ? 256 : bytes.readUInt8(at);
		const length = bytes.readUInt32LE(at + 8);
		const start = bytes.readUInt32LE(at + 12);
		const signature = bytes.readUInt32BE(start);
		if (signature !== 0x89504e47) {
			throw new Error(`a entrada ${index} não é PNG`);
		}
		sizes.push(`${width} (${length} bytes)`);
	}
	console.log(`[icon] ${TARGET}`);
	console.log(`[icon] ícone real: ${count} entradas — ${sizes.join(', ')}`);
	console.log(`[icon] ${Math.round(bytes.length / 1024)} KB`);
}

resizeAll();
pack();
verify();
fs.rmSync(WORK, { recursive: true, force: true });
