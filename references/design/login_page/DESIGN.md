---
name: Mandala Sekuritas Landing Page
description: High-fidelity dark mode native landing page blending premium financial
  features with accessible retail onboarding.
colors:
  primary: '#E62225'
  secondary: '#0F2C59'
  background: '#0D1117'
  surface: '#161B22'
  text-primary: '#FFFFFF'
  text-secondary: '#8B949E'
  border: '#21262D'
  success: '#10B981'
  error: '#EF4444'
  surface-dim: '#1f0f0d'
  surface-bright: '#493431'
  surface-container-lowest: '#1a0a08'
  surface-container-low: '#291715'
  surface-container: '#2d1b19'
  surface-container-high: '#392523'
  surface-container-highest: '#45302d'
  on-surface: '#fddbd7'
  on-surface-variant: '#e7bdb8'
  inverse-surface: '#fddbd7'
  inverse-on-surface: '#402b29'
  outline: '#ae8883'
  outline-variant: '#5d3f3c'
  surface-tint: '#ffb4ab'
  on-primary: '#690006'
  primary-container: '#e62225'
  on-primary-container: '#ffffff'
  inverse-primary: '#c00013'
  on-secondary: '#132f5d'
  secondary-container: '#2f4977'
  on-secondary-container: '#a0b8ee'
  tertiary: '#8fcdff'
  on-tertiary: '#003450'
  tertiary-container: '#007db9'
  on-tertiary-container: '#ffffff'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#ffdad6'
  primary-fixed-dim: '#ffb4ab'
  on-primary-fixed: '#410002'
  on-primary-fixed-variant: '#93000c'
  secondary-fixed: '#d8e2ff'
  secondary-fixed-dim: '#aec7fd'
  on-secondary-fixed: '#001a41'
  on-secondary-fixed-variant: '#2d4674'
  tertiary-fixed: '#cbe6ff'
  tertiary-fixed-dim: '#8fcdff'
  on-tertiary-fixed: '#001e30'
  on-tertiary-fixed-variant: '#004b71'
  on-background: '#fddbd7'
  surface-variant: '#45302d'
typography:
  h1:
    fontFamily: Inter, sans-serif
    fontSize: 3rem
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: -0.02em
  h2:
    fontFamily: Inter, sans-serif
    fontSize: 1.5rem
    fontWeight: 600
    lineHeight: 1.3
  body-md:
    fontFamily: Inter, sans-serif
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.6
  label-sm:
    fontFamily: Inter, sans-serif
    fontSize: 0.85rem
    fontWeight: 500
    lineHeight: 16px
  headline-xl:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 52.8px
    letterSpacing: -0.02em
  headline-xl-mobile:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 38px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 31.2px
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  xl: 16px
  full: 9999px
  DEFAULT: 0.5rem
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
  3xl: 64px
  gutter: 24px
  margin: 32px
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.text-primary}'
    rounded: '{rounded.md}'
    padding: 12px 24px
  button-ghost:
    backgroundColor: transparent
    borderColor: '{colors.border}'
    textColor: '{colors.text-primary}'
    rounded: '{rounded.md}'
    padding: 12px 24px
  card-isometric:
    backgroundColor: '{colors.surface}'
    borderColor: '{colors.border}'
    rounded: '{rounded.lg}'
    padding: '{spacing.lg}'
---

## Overview
Desain landing page Mandala Sekuritas mengusung harmoni antara teknologi finansial mutakhir dengan kemudahan akses pasar modal. Menggunakan arsitektur Dark Mode Native yang dikombinasikan dengan sentuhan warna korporat yang berani (Vibrant Red & Deep Navy Blue) untuk menciptakan atmosfer trading yang fokus, bertenaga, sekaligus tepercaya bagi investor pemula maupun berpengalaman.
## Colors
Warna utama merah (`#E62225`) dialokasikan secara ketat hanya untuk komponen High-Conversion Call-to-Action (CTA) serta elemen fokus pada teks. Latar belakang gelap (`#0D1117`) berpadu dengan warna panel (`#161B22`) untuk mereduksi kelelahan mata (eye-strain) saat mengamati pergerakan pasar saham dalam durasi panjang.
## Typography
Tipografi menggunakan rumpun Geometric Sans-serif untuk menjaga keterbacaan data numerik yang padat. Skala rasio ketat diaplikasikan pada H1 untuk memberikan impak visual instan dalam satu kali tatap tanpa mengorbankan ruang kosong (whitespace) di sekitarnya.
## Spacing & Layout
Mengadopsi sistem grid asimetris 12-kolom pada tampilan desktop. Kolom kiri difungsikan sebagai jangkar informasi naratif konvensional, sementara kolom kanan dieksploitasi menggunakan teknik layering objek isometrik 3D untuk memamerkan kecanggihan fitur teknikal internal platform tanpa membuat penuh layar.
## Shapes & Radius
Sudut lengkung sedang (8px–12px) diterapkan untuk mempertahankan karakteristik industri finansial yang tegas namun modern, menghindari sudut tajam 0px (yang terlalu kaku) ataupun sudut pillowy >20px (yang terlalu kasual).
## Elevation & Depth
Efek kedalaman tidak mengandalkan bayangan buram berskala besar (heavy shadows), melainkan memanfaatkan teknik penumpukan layer komponen fisik (layering), garis pembatas tipis berukuran 1px (hairline border), dan pendaran ambien warna neon tipis pada area perimeter luar kanvas.
## Components
Seluruh komponen interaktif dibekali penanda mikro-interaksi yang responsif:
- `button-primary`: Mengalami transisi kecerahan warna saat cursor melakukan hover.
- `card-isometric`: Memiliki pergeseran ketinggian visual sumbu-Z ringan untuk mempertegas elemen fungsional yang dapat diklik.
- `complex-chart`: Memuat visualisasi candlestick padat dengan penanda harga tabular.
## Rules to Never Break
- Jangan pernah menggunakan warna latar belakang terang (Pure White/Light Mode) pada komponen utama dashboard.
- Jangan mengganti teks riil finansial dengan teks generik (Lorem Ipsum) demi menjaga relevansi konteks data saat proses rendering kode.
- Pastikan rasio kontras teks utama selalu memenuhi standar baku WCAG AAA untuk aksesibilitas pengguna.