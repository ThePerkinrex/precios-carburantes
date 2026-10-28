//! Helpers shared by the models, on top of nalgebra.

use nalgebra::{DMatrix, DVector};

/// The `q` quantile with linear interpolation (numpy's default).
pub fn quantile(values: &[f64], q: f64) -> f64 {
    let mut v = values.to_vec();
    v.sort_by(f64::total_cmp);
    let pos = q * (v.len() - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = (lo + 1).min(v.len() - 1);
    v[lo] + (v[hi] - v[lo]) * (pos - lo as f64)
}

/// Rows as a matrix.
pub fn matrix(rows: &[Vec<f64>]) -> DMatrix<f64> {
    DMatrix::from_fn(rows.len(), rows[0].len(), |i, j| rows[i][j])
}

/// How a model standardizes its inputs: column means and population standard deviations,
/// with columns that barely moved in training (sd under `tol`) marked flat.
pub struct Scaling {
    pub mean: Vec<f64>,
    pub std: Vec<f64>,
    pub flat: Vec<bool>,
}

impl Scaling {
    pub fn fit(x: &DMatrix<f64>, tol: f64) -> Self {
        let mean: Vec<f64> = x.column_iter().map(|c| c.mean()).collect();
        let mut std: Vec<f64> = x
            .column_iter()
            .zip(&mean)
            .map(|(c, m)| (c.map(|v| (v - m).powi(2)).mean()).sqrt())
            .collect();
        let flat: Vec<bool> = std.iter().map(|&s| s < tol).collect();
        for (s, &f) in std.iter_mut().zip(&flat) {
            if f {
                *s = 1.0;
            }
        }
        Scaling { mean, std, flat }
    }

    pub fn apply(&self, x: &DMatrix<f64>) -> DMatrix<f64> {
        DMatrix::from_fn(x.nrows(), x.ncols(), |i, j| {
            (x[(i, j)] - self.mean[j]) / self.std[j]
        })
    }
}

/// Solves a small dense system; None if it's singular.
pub fn solve(a: DMatrix<f64>, b: DVector<f64>) -> Option<DVector<f64>> {
    a.lu().solve(&b)
}
