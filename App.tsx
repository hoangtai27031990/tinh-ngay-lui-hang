
import React, { useState } from 'react';
import Header from './components/Header';
import ResultDisplay from './components/ResultDisplay';
import { FormData, CalculationResult } from './types';
import { calculateWithdrawal } from './utils/dateUtils';

const App: React.FC = () => {
  const [formData, setFormData] = useState<FormData>({ nsx: '', hsd: '' });
  const [result, setResult] = useState<CalculationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    setError(null);
  };

  const handleCalculate = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.nsx || !formData.hsd) {
      setError('Vui lòng nhập đầy đủ Ngày Sản Xuất và Hạn Sử Dụng.');
      return;
    }

    const nsx = new Date(formData.nsx);
    const hsd = new Date(formData.hsd);

    if (nsx >= hsd) {
      setError('Ngày sản xuất phải nhỏ hơn Hạn sử dụng.');
      return;
    }

    const calcResult = calculateWithdrawal(formData.nsx, formData.hsd);
    setResult(calcResult);
  };

  const handleReset = () => {
    setFormData({ nsx: '', hsd: '' });
    setResult(null);
    setError(null);
  };

  return (
    <div className="min-h-screen bg-slate-50 pb-12">
      <Header />

      <main className="max-w-md mx-auto px-4">
        <div className="bg-white rounded-2xl p-6 shadow-md">
          <form onSubmit={handleCalculate} className="space-y-6">
            <div>
              <label htmlFor="nsx" className="block text-sm font-semibold text-slate-700 mb-2">
                Ngày Sản Xuất (NSX)
              </label>
              <input
                type="date"
                id="nsx"
                name="nsx"
                value={formData.nsx}
                onChange={handleInputChange}
                className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-slate-50 transition-all"
              />
            </div>

            <div>
              <label htmlFor="hsd" className="block text-sm font-semibold text-slate-700 mb-2">
                Hạn Sử Dụng (HSD)
              </label>
              <input
                type="date"
                id="hsd"
                name="hsd"
                value={formData.hsd}
                onChange={handleInputChange}
                className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-slate-50 transition-all"
              />
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-200 text-red-600 rounded-xl text-sm font-medium flex items-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                {error}
              </div>
            )}

            <div className="flex flex-col space-y-3 pt-2">
              <button
                type="submit"
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-xl shadow-lg shadow-blue-200 transition-all active:scale-95 flex items-center justify-center space-x-2"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM7 9a1 1 0 000 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
                </svg>
                <span>Tính kết quả</span>
              </button>
              
              <button
                type="button"
                onClick={handleReset}
                className="w-full bg-slate-100 hover:bg-slate-200 text-slate-600 font-semibold py-3 rounded-xl transition-all flex items-center justify-center space-x-2"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 110 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
                </svg>
                <span>Nhập lại</span>
              </button>
            </div>
          </form>
        </div>

        <ResultDisplay result={result} />

        <div className="mt-8 text-center">
          <div className="inline-block p-4 bg-amber-50 rounded-2xl border border-amber-100">
            <h3 className="text-amber-800 font-bold text-sm mb-1">Hướng dẫn quy tắc:</h3>
            <p className="text-amber-700 text-xs leading-relaxed">
              Sản phẩm phải được lùi hàng khi thời gian còn lại dưới 20% tổng HSD.<br/>
              Công thức: <span className="font-mono font-bold">Ngày lùi = HSD - (Tổng ngày x 20%)</span>
            </p>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
