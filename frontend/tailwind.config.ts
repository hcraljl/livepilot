import type { Config } from 'tailwindcss';

/**
 * Tailwind 配置 —— 语义色 token 化（规范 §2.7）
 * 组件内只准使用 token，禁止魔法色值；如需整体换肤只改此处
 * 色板与项目架构图/时间线图表保持一致（blue/teal/amber/red）
 * 负责人：A · @since v0.1.0
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 品牌主色（蓝）
        brand: {
          50: '#E6F1FB',
          100: '#B5D4F4',
          200: '#85B7EB',
          400: '#378ADD',
          600: '#185FA5',
          800: '#0C447C',
          900: '#042C53',
        },
        // 正向指标（teal）—— 产品语义色，非股票行情场景
        success: {
          50: '#E1F5EE',
          100: '#9FE1CB',
          200: '#5DCAA5',
          400: '#1D9E75',
          600: '#0F6E56',
          800: '#085041',
        },
        // 警示（amber）
        warn: {
          50: '#FAEEDA',
          100: '#FAC775',
          200: '#EF9F27',
          400: '#BA7517',
          600: '#854F0B',
          800: '#633806',
        },
        // 负向/危险（red）
        danger: {
          50: '#FCEBEB',
          100: '#F7C1C1',
          200: '#F09595',
          400: '#E24B4A',
          600: '#A32D2D',
          800: '#791F1F',
        },
      },
    },
  },
  plugins: [],
};

export default config;
