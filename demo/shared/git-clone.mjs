export async function cloneWithSingleBranchFallback(cloneRepo, cloneArgs, onFallback = null) {
  try {
    return await cloneRepo(cloneArgs);
  } catch (error) {
    if (cloneArgs?.singleBranch !== true) {
      throw error;
    }
    if (typeof onFallback === 'function') {
      onFallback(error);
    }
    return cloneRepo({
      ...cloneArgs,
      singleBranch: false,
    });
  }
}
